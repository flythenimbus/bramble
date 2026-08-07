//! The autofill index the browser link answers from.
//!
//! Pushed by the main window on unlock and cleared on lock, through `@core`'s existing
//! `AutofillAdapter.setIndex` / `clearIndex`, which the vault already calls at exactly those
//! moments. Nothing new had to be invented for the desktop to know what the vault holds.
//!
//! The index contains passwords, because that is what autofill needs at fill time; the
//! extension's background service worker holds the same thing for the same reason. What
//! matters is that a password never crosses the socket for a *query*: a lookup answers with
//! MatchSummary, which is id, name and a secondary line, and the secret is fetched separately
//! for one entry at the moment it is used. See docs/desktop-port.md.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// One indexed login. Only the fields the link actually answers with are modelled; the rest of
/// what `@core` pushes is carried through `serde(default)` obscurity rather than mirrored,
/// so adding a field on the TS side does not break the desktop.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    #[serde(default)]
    pub id: String,
    /// "login", "card", ... Only logins are matched by hostname.
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub hostnames: Vec<String>,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub totp: Option<String>,
}

/// What a query is allowed to answer with: no secret of any kind.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchSummary {
    pub id: String,
    pub name: String,
    /// The username for a login. Named to match `@core`'s MatchSummary so the extension can
    /// hand it straight to code that already renders one.
    pub secondary: String,
}

static INDEX: Mutex<Vec<IndexEntry>> = Mutex::new(Vec::new());

pub fn set(entries: Vec<IndexEntry>) {
    *INDEX.lock().unwrap() = entries;
}

pub fn clear() {
    INDEX.lock().unwrap().clear();
}

#[allow(dead_code)] // Read by tests and useful in a log line; no caller in the app yet.
pub fn count() -> usize {
    INDEX.lock().unwrap().len()
}

/// Logins registered against `hostname`, as metadata only.
///
/// Matching is exact on the indexed hostname. `@core` owns the real policy (registrable
/// domain, per-entry subdomain modes) and the desktop deliberately does not reimplement it:
/// a second matcher that disagreed with the first would be worse than a strict one.
pub fn query(hostname: &str) -> Vec<MatchSummary> {
    let needle = hostname.trim().to_ascii_lowercase();
    INDEX
        .lock()
        .unwrap()
        .iter()
        .filter(|e| e.kind == "login")
        .filter(|e| e.hostnames.iter().any(|h| h.to_ascii_lowercase() == needle))
        .map(|e| MatchSummary {
            id: e.id.clone(),
            name: e.name.clone(),
            secondary: e.username.clone(),
        })
        .collect()
}

/// The secret for one entry. Separate from `query` on purpose: this is the call that hands
/// over a credential, so it is the one that has to be tied to an explicit use.
pub fn secret_for(id: &str) -> Option<IndexEntry> {
    INDEX.lock().unwrap().iter().find(|e| e.id == id).cloned()
}

// ---- commands ----

#[tauri::command]
pub fn link_set_index(entries: Vec<IndexEntry>) {
    set(entries);
}

#[tauri::command]
pub fn link_clear_index() {
    clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The index is one process-global value, shared with the socket tests that drive it
    /// through a real connection. Without this they overwrite each other's fixtures.
    use crate::pairing::test_lock;

    fn login(id: &str, host: &str, user: &str) -> IndexEntry {
        IndexEntry {
            id: id.into(),
            kind: "login".into(),
            name: format!("{host} account"),
            hostnames: vec![host.into()],
            username: user.into(),
            password: "hunter2".into(),
            totp: None,
        }
    }

    #[test]
    fn a_query_answers_with_no_secret() {
        let _g = test_lock();
        set(vec![login("a", "github.com", "octocat")]);
        let hits = query("github.com");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].secondary, "octocat");
        // The type makes this structural rather than a promise, but assert it anyway: this is
        // the whole reason query and fetch are separate calls.
        let json = serde_json::to_string(&hits[0]).unwrap();
        assert!(
            !json.contains("hunter2"),
            "a query leaked a password: {json}"
        );
    }

    #[test]
    fn matching_is_case_insensitive_on_the_hostname() {
        let _g = test_lock();
        set(vec![login("a", "GitHub.com", "octocat")]);
        assert_eq!(query("github.com").len(), 1);
        assert_eq!(query("  GITHUB.COM  ").len(), 1);
    }

    #[test]
    fn an_unrelated_host_matches_nothing() {
        let _g = test_lock();
        set(vec![login("a", "github.com", "octocat")]);
        assert!(query("evil.example").is_empty());
        // Substrings must not match either, or evil-github.com would harvest github logins.
        assert!(query("hub.com").is_empty());
    }

    #[test]
    fn only_logins_are_matched_by_hostname() {
        let _g = test_lock();
        let mut card = login("c", "github.com", "");
        card.kind = "card".into();
        set(vec![card]);
        assert!(query("github.com").is_empty());
    }

    #[test]
    fn clearing_empties_the_index() {
        let _g = test_lock();
        set(vec![login("a", "github.com", "octocat")]);
        clear();
        assert_eq!(count(), 0);
        assert!(query("github.com").is_empty());
        assert!(secret_for("a").is_none());
    }

    #[test]
    fn the_secret_is_reachable_only_by_id() {
        let _g = test_lock();
        set(vec![login("a", "github.com", "octocat")]);
        assert_eq!(secret_for("a").unwrap().password, "hunter2");
        assert!(secret_for("nope").is_none());
    }

    #[test]
    fn an_unknown_entry_shape_does_not_break_the_index() {
        let _g = test_lock();
        // @core pushes more fields than this models. A new one must not make the whole push
        // fail, which would silently leave the link answering from a stale index.
        let raw = r#"[{"id":"a","type":"login","name":"n","hostnames":["x.test"],
                       "username":"u","password":"p","somethingNew":true}]"#;
        let parsed: Vec<IndexEntry> = serde_json::from_str(raw).expect("unknown fields ignored");
        assert_eq!(parsed.len(), 1);
    }
}
