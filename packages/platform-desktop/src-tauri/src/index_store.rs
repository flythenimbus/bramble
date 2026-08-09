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

use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

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

/// Matches the extension's clipboard behaviour.
const CLEAR_AFTER: Duration = Duration::from_secs(30);

/// Bumped per copy, so only the most recent one schedules the clear that lands.
static COPY_GENERATION: AtomicU64 = AtomicU64::new(0);

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

/// Put a result's password on the clipboard and dismiss the panel.
///
/// Done here rather than by handing the secret to the panel: the whole point of that webview
/// answering with metadata only is that a credential never reaches it, and routing a copy
/// through it to reach the clipboard would give that up for nothing.
///
/// Cleared after the same window the rest of the app uses. Best-effort, and it does not check
/// whether the clipboard is still ours first: reading it back needs a permission this app does
/// not otherwise want, and wiping something the user copied since would be the worse mistake.
#[tauri::command]
pub fn spotlight_copy_password(app: AppHandle, id: String) -> Result<(), String> {
    if vault_crypto::is_locked() {
        return Err("locked".into());
    }
    let entry = secret_for(&id).ok_or("unknown entry")?;
    if entry.password.is_empty() {
        return Err("no password".into());
    }
    app.clipboard()
        .write_text(entry.password)
        .map_err(|e| format!("clipboard: {e}"))?;

    let generation = COPY_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    let handle = app.clone();
    thread::spawn(move || {
        thread::sleep(CLEAR_AFTER);
        // A later copy owns the clipboard now; clearing would wipe that instead.
        if COPY_GENERATION.load(Ordering::Relaxed) == generation {
            let _ = handle.clipboard().clear();
        }
    });
    crate::spotlight::hide(&app);
    Ok(())
}

/// A free-text search across the index, for the quick-access panel.
///
/// Metadata only, like every other read here: the panel lists what it finds and asks for a
/// secret only when the user acts on one, so a search never puts a credential in the webview.
///
/// Matching is a case-insensitive substring over the name, the username and the hostnames,
/// which is what someone typing "git" into a search field means. Ranked so a name match beats a
/// hostname match and a hostname beats a username: the name is what the user gave the entry, so
/// an entry called "GitHub" should not sit below one that merely happens to be registered
/// against a github.com page.
#[tauri::command]
pub fn spotlight_search(query: String, limit: usize) -> Vec<MatchSummary> {
    let needle = query.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    let contains = |hay: &str| hay.to_ascii_lowercase().contains(&needle);
    // Bound to a local so the guard outlives the borrows taken from it.
    let index = INDEX.lock().unwrap();
    let mut hits: Vec<(u8, &IndexEntry)> = index
        .iter()
        .filter_map(|e| {
            // Lower rank sorts first.
            if contains(&e.name) {
                Some((0, e))
            } else if e.hostnames.iter().any(|h| contains(h)) {
                Some((1, e))
            } else if contains(&e.username) {
                Some((2, e))
            } else {
                None
            }
        })
        .collect();
    hits.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.name.cmp(&b.1.name)));
    hits.truncate(limit);
    hits.into_iter()
        .map(|(_, e)| MatchSummary {
            id: e.id.clone(),
            name: e.name.clone(),
            secondary: e.username.clone(),
        })
        .collect()
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
    fn search_finds_by_name_hostname_and_username() {
        let _g = crate::pairing::test_lock();
        set(vec![
            IndexEntry {
                id: "a".into(),
                kind: "login".into(),
                name: "GitHub".into(),
                hostnames: vec!["github.com".into()],
                username: "hue".into(),
                ..Default::default()
            },
            IndexEntry {
                id: "b".into(),
                kind: "login".into(),
                name: "Work mail".into(),
                hostnames: vec!["mail.example.com".into()],
                username: "someone@github.example".into(),
                ..Default::default()
            },
        ]);

        // The name match must outrank the one that merely mentions github in a username: the
        // name is what the user gave the entry, so it is what they are typing at.
        let hits = spotlight_search("github".into(), 10);
        assert_eq!(
            hits.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["a", "b"]
        );

        assert_eq!(spotlight_search("HUE".into(), 10).len(), 1, "case-insensitive");
        assert_eq!(spotlight_search("mail.example".into(), 10).len(), 1, "hostname substring");
    }

    #[test]
    fn search_answers_with_no_secrets() {
        // The panel renders these in a webview. A search must never be the thing that puts a
        // password there; that only happens when the user acts on a result.
        let _g = crate::pairing::test_lock();
        set(vec![IndexEntry {
            id: "a".into(),
            kind: "login".into(),
            name: "GitHub".into(),
            username: "hue".into(),
            password: "hunter2".into(),
            totp: Some("otpauth://x".into()),
            ..Default::default()
        }]);

        let json = serde_json::to_string(&spotlight_search("git".into(), 10)).unwrap();
        assert!(!json.contains("hunter2"), "password in a search answer: {json}");
        assert!(!json.contains("otpauth"), "totp in a search answer: {json}");
    }

    #[test]
    fn search_is_bounded_and_empty_for_an_empty_query() {
        let _g = crate::pairing::test_lock();
        set((0..50)
            .map(|i| IndexEntry {
                id: i.to_string(),
                kind: "login".into(),
                name: format!("site {i}"),
                ..Default::default()
            })
            .collect());

        assert_eq!(spotlight_search("site".into(), 8).len(), 8);
        // An empty field lists nothing rather than everything: the panel opens empty, and
        // dumping the vault into it would be both useless and a shoulder-surfing surface.
        assert!(spotlight_search("   ".into(), 8).is_empty());
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
