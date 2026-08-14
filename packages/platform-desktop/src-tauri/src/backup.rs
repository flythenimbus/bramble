//! Cloud backups that do not need the vault key.
//!
//! Two facts about this platform shape the whole module.
//!
//! The webview cannot reach a backup provider at all: its origin is `tauri://localhost`, and no
//! S3 endpoint or WebDAV server sends that a CORS grant, so a `fetch` there fails before it hits
//! the network. Every request therefore leaves from this process.
//!
//! Given that, the credentials belong here too, in the OS credential store next to the sync
//! device identity (see `secure_store`), rather than wrapped under the vault key. That is what
//! makes a desktop backup *schedule* mean something: the app is tray-resident and the vault blob
//! is readable while locked, so the only thing that used to force "backups only while you happen
//! to have that vault unlocked" was the credential wrap. With it gone, each vault's timer is
//! honoured whether or not anything is unlocked.
//!
//! The trade, stated in docs/cloud-storage-backups.md: these credentials become OS-account
//! protected rather than master-password protected. What they reach is a bucket of ciphertext
//! (the backups stay sealed by the master password), and the same store already holds strictly
//! more powerful secrets. The plaintext never crosses into the webview: it goes in once at save
//! time and is used only here.

use std::collections::HashMap;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use vault_crypto::sigv4::{sign_s3, S3Credentials, SignRequest};

use crate::secure_store;

type Res<T> = Result<T, String>;

/// Credential-store accounts owned by this module. `secure_store` refuses these through its
/// generic commands, so the webview can neither read them back nor overwrite them.
pub const CREDS_PREFIX: &str = "backup.creds:";
/// A name that is never written. Reading it tells us whether the store answers at all.
const PROBE: &str = "backup.creds:.probe";

fn account(vault_id: &str, target_id: &str) -> String {
    format!("{CREDS_PREFIX}{vault_id}:{target_id}")
}

/// How to authenticate one target's requests. The provider kind decides it, so the webview says
/// which one applies and this side supplies the secret.
#[derive(Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AuthSpec {
    /// S3-compatible: SigV4, signed here.
    S3 { region: String },
    /// WebDAV: an `Authorization: Basic` header built here.
    Basic,
}

#[derive(Deserialize)]
struct S3Secrets {
    #[serde(rename = "accessKeyId")]
    access_key_id: String,
    #[serde(rename = "secretAccessKey")]
    secret_access_key: String,
}

#[derive(Deserialize)]
struct BasicSecrets {
    username: String,
    password: String,
}

#[derive(Serialize)]
pub struct HttpReply {
    pub status: u16,
    /// Whole body. A listing or one vault blob, never a stream.
    pub body: Vec<u8>,
}

/// `YYYYMMDDTHHMMSSZ`, the stamp SigV4 signs over and sends as `x-amz-date`.
fn amz_date() -> String {
    chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string()
}

/// Turn an unauthenticated request into the exact one to send: the URL (with the canonical query
/// SigV4 signed, so the wire form and the signed form cannot diverge) and the full header list.
///
/// Separated from the sending so signing is testable with no network and no credential store.
fn prepare(
    auth: &AuthSpec,
    secrets_json: &str,
    method: &str,
    url: &str,
    headers: Vec<(String, String)>,
    body: &[u8],
    stamp: &str,
) -> Res<(reqwest::Url, Vec<(String, String)>)> {
    let mut url = reqwest::Url::parse(url).map_err(|e| format!("backup url: {e}"))?;
    match auth {
        AuthSpec::S3 { region } => {
            let s: S3Secrets = serde_json::from_str(secrets_json)
                .map_err(|e| format!("stored S3 credentials unreadable: {e}"))?;
            // The Host header carries the port when it is not the scheme's default, and the
            // signature covers Host, so it has to be built the same way here.
            let host = match url.port() {
                Some(port) => format!("{}:{port}", url.host_str().unwrap_or_default()),
                None => url.host_str().unwrap_or_default().to_string(),
            };
            let query: Vec<(String, String)> = url
                .query_pairs()
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
            let signed = sign_s3(
                &SignRequest {
                    method,
                    host: &host,
                    uri_path: url.path(),
                    query: &query,
                    headers: &headers,
                    body,
                },
                &S3Credentials {
                    access_key_id: s.access_key_id,
                    secret_access_key: s.secret_access_key,
                    region: region.clone(),
                },
                "s3",
                stamp,
            );
            if signed.canonical_query.is_empty() {
                url.set_query(None);
            } else {
                url.set_query(Some(&signed.canonical_query));
            }
            Ok((url, signed.headers))
        }
        AuthSpec::Basic => {
            let s: BasicSecrets = serde_json::from_str(secrets_json)
                .map_err(|e| format!("stored WebDAV credentials unreadable: {e}"))?;
            let mut out = headers;
            out.push((
                "Authorization".to_string(),
                format!("Basic {}", B64.encode(format!("{}:{}", s.username, s.password))),
            ));
            Ok((url, out))
        }
    }
}

/// Event the main window listens for to evaluate every vault's schedule.
pub const TICK_EVENT: &str = "backup://tick";
// A cheap poke; the listener no-ops unless a target is due and its vault changed. The schedules
// themselves are daily at their most frequent, so the resolution only bounds how late a run is.
const TICK_MINUTES: u64 = 5;
// Not immediately at launch: the window has to mount its listener first, and a machine that just
// booted has better things to do for a moment.
const FIRST_TICK_SECONDS: u64 = 30;

/// Drive the schedule from this process rather than from a JS timer: the main window is usually
/// hidden (closing it hides it, see `lifetime`), and a hidden webview's timers are throttled by
/// the platform. A thread that sleeps is immune to that, and it is the piece that makes the app's
/// tray residency actually mean "your backups run".
pub fn start_ticker(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        use tauri::Emitter;
        std::thread::sleep(std::time::Duration::from_secs(FIRST_TICK_SECONDS));
        loop {
            if let Err(e) = app.emit(TICK_EVENT, ()) {
                log::warn!("backup tick not delivered: {e}");
            }
            std::thread::sleep(std::time::Duration::from_secs(TICK_MINUTES * 60));
        }
    });
}

// ---- commands ----

/// Whether the OS credential store answers. A Linux session with no Secret Service does not, and
/// the caller then falls back to vault-key-wrapped credentials and unlock-gated backups, which is
/// how every other platform works. Reads a name that is never written, so this creates nothing.
#[tauri::command]
pub fn backup_creds_available() -> bool {
    secure_store::read(PROBE).is_ok()
}

#[tauri::command]
pub fn backup_creds_save(vault_id: String, target_id: String, secrets: String) -> Res<()> {
    secure_store::write(&account(&vault_id, &target_id), &secrets)
}

#[tauri::command]
pub fn backup_creds_remove(vault_id: String, target_id: String) -> Res<()> {
    secure_store::erase(&account(&vault_id, &target_id))
}

/// One authenticated request to a backup provider. The webview builds the request; the secret is
/// added here and never travels back.
#[tauri::command]
pub async fn backup_send(
    vault_id: String,
    target_id: String,
    auth: AuthSpec,
    method: String,
    url: String,
    headers: HashMap<String, String>,
    body: Option<Vec<u8>>,
) -> Res<HttpReply> {
    let secrets = secure_store::read(&account(&vault_id, &target_id))?
        .ok_or("no stored credentials for this backup target")?;
    let body = body.unwrap_or_default();
    let (url, headers) = prepare(
        &auth,
        &secrets,
        &method,
        &url,
        headers.into_iter().collect(),
        &body,
        &amz_date(),
    )?;

    // No redirect following: a 3xx would move the request off the URL that was signed, and both
    // protocols address objects directly, so a redirect is a misconfiguration worth surfacing.
    // No cookie store either, for the reason the WebDAV client documents: an ambient session for
    // the same host outranks our Authorization header on Nextcloud and then fails its CSRF check.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let mut req = client.request(
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| format!("http method: {e}"))?,
        url,
    );
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let res = req
        .body(body)
        .send()
        .await
        .map_err(|e| format!("backup request failed: {e}"))?;
    let status = res.status().as_u16();
    let body = res
        .bytes()
        .await
        .map_err(|e| format!("backup response failed: {e}"))?
        .to_vec();
    Ok(HttpReply { status, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    const STAMP: &str = "20260814T101112Z";

    fn s3_secrets() -> String {
        r#"{"accessKeyId":"AKIAIOSFODNN7EXAMPLE","secretAccessKey":"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}"#.to_string()
    }

    fn header<'a>(headers: &'a [(String, String)], name: &str) -> &'a str {
        headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
            .unwrap_or_default()
    }

    #[test]
    fn credential_accounts_are_namespaced_per_vault_and_target() {
        assert_eq!(account("v1", "t1"), "backup.creds:v1:t1");
        assert!(account("v1", "t1").starts_with(CREDS_PREFIX));
    }

    /// The signature must match the same request signed by the shared core, and the URL that goes
    /// out must carry the canonical query that was signed, not the one the caller happened to write.
    #[test]
    fn s3_requests_are_signed_and_sent_with_the_canonical_query() {
        let (url, headers) = prepare(
            &AuthSpec::S3 {
                region: "us-west-002".into(),
            },
            &s3_secrets(),
            "GET",
            "https://s3.example.com/mybucket?prefix=bramble%2Fsub%20dir&list-type=2",
            vec![],
            b"",
            STAMP,
        )
        .unwrap();
        assert_eq!(url.query(), Some("list-type=2&prefix=bramble%2Fsub%20dir"));
        // Same vector as the TS signer and core-rust's own tests.
        assert!(header(&headers, "Authorization").ends_with(
            "Signature=12298afe7ab9cedfe97718ba079224eb453fea81f57fcd8912b6061d51281a1e"
        ));
        assert_eq!(header(&headers, "x-amz-date"), STAMP);
    }

    #[test]
    fn s3_signing_covers_a_non_default_port_in_the_host_header() {
        let signed_default = prepare(
            &AuthSpec::S3 {
                region: "us-east-1".into(),
            },
            &s3_secrets(),
            "GET",
            "https://minio.example.com/b/k",
            vec![],
            b"",
            STAMP,
        )
        .unwrap()
        .1;
        let signed_port = prepare(
            &AuthSpec::S3 {
                region: "us-east-1".into(),
            },
            &s3_secrets(),
            "GET",
            "https://minio.example.com:9000/b/k",
            vec![],
            b"",
            STAMP,
        )
        .unwrap()
        .1;
        // The port is part of Host, so it must change the signature; a server that saw the
        // portless form would reject it.
        assert_ne!(
            header(&signed_default, "Authorization"),
            header(&signed_port, "Authorization")
        );
    }

    #[test]
    fn webdav_requests_get_a_basic_header_and_an_untouched_url() {
        let (url, headers) = prepare(
            &AuthSpec::Basic,
            r#"{"username":"admin","password":"Bramble-test-123"}"#,
            "PROPFIND",
            "http://localhost:8080/remote.php/dav/files/admin/bramble/",
            vec![("Depth".into(), "1".into())],
            b"",
            STAMP,
        )
        .unwrap();
        assert_eq!(
            url.as_str(),
            "http://localhost:8080/remote.php/dav/files/admin/bramble/"
        );
        assert_eq!(
            header(&headers, "Authorization"),
            "Basic YWRtaW46QnJhbWJsZS10ZXN0LTEyMw=="
        );
        assert_eq!(header(&headers, "Depth"), "1");
    }

    #[test]
    fn unreadable_stored_credentials_are_an_error_not_a_panic() {
        let err = prepare(
            &AuthSpec::Basic,
            "not json",
            "GET",
            "https://example.com/",
            vec![],
            b"",
            STAMP,
        )
        .unwrap_err();
        assert!(err.contains("WebDAV credentials"), "{err}");
    }

    #[test]
    fn a_stamp_is_the_shape_sigv4_requires() {
        let stamp = amz_date();
        assert_eq!(stamp.len(), 16, "{stamp}");
        assert!(stamp.ends_with('Z') && stamp.contains('T'), "{stamp}");
        assert!(stamp[..8].chars().all(|c| c.is_ascii_digit()), "{stamp}");
    }
}
