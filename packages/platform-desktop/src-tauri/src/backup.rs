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
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::secure_store;

type Res<T> = Result<T, String>;

/// Credential-store accounts owned by this module. `secure_store` refuses these through its
/// generic commands, so the webview can neither read them back nor overwrite them.
pub const CREDS_PREFIX: &str = "backup.creds:";
fn account(vault_id: &str, target_id: &str) -> String {
    format!("{CREDS_PREFIX}{vault_id}:{target_id}")
}

/// How to authenticate one target's requests.
///
/// The first two read the secret from the credential store, which is the normal path. The
/// `*Inline` pair carries it in the call instead, for the machine that has no usable credential
/// store (a Linux session with no Secret Service): there the credentials stay wrapped under the
/// vault key and the webview unwraps them per run, exactly as the extension does. The request
/// still has to be sent from here, because the webview cannot reach a provider at all.
#[derive(Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AuthSpec {
    /// S3-compatible: SigV4, signed here with the stored secret.
    S3 { region: String },
    /// WebDAV: an `Authorization: Basic` header built here from the stored secret.
    Basic,
    /// SigV4 with credentials supplied by the caller (no credential store on this machine).
    S3Inline {
        region: String,
        access_key_id: String,
        secret_access_key: String,
    },
    /// Basic auth with credentials supplied by the caller (no credential store on this machine).
    BasicInline { username: String, password: String },
}

impl AuthSpec {
    /// Whether this request's secret comes from the credential store, in which case the stored
    /// origin pin applies. An inline secret is the caller's own and needs no pin: it already had
    /// the credential before it called.
    fn uses_stored_secret(&self) -> bool {
        matches!(self, AuthSpec::S3 { .. } | AuthSpec::Basic)
    }
}

// Zeroized on drop, and no Debug: these are the only plaintext copies of a user's provider
// credential in this process, and they are handled while the vault they belong to may be locked.
#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
struct S3Secrets {
    #[serde(rename = "accessKeyId")]
    access_key_id: String,
    #[serde(rename = "secretAccessKey")]
    secret_access_key: String,
}

#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
struct BasicSecrets {
    username: String,
    password: String,
}

/// What the credential store holds for one target: the secret, and the ONE origin it may ever be
/// sent to.
///
/// The origin is the whole reason this record exists rather than a bare secret. Refusing to hand
/// the credential back to the webview (see `secure_store`'s reserved prefix) is worth nothing on
/// its own, because the webview also names the URL each request goes to: point it at
/// `https://attacker.example` and this process would attach `Authorization: Basic ...` and mail
/// the credential out. Pinning the origin at save time, inside an item the webview cannot read or
/// rewrite, is what actually contains it.
#[derive(Serialize, Deserialize)]
struct StoredCreds {
    /// `scheme://host[:port]`, from the endpoint or server URL the user configured.
    origin: String,
    /// The provider's secret fields, shape depending on the provider kind.
    secrets: serde_json::Value,
}

/// `scheme://host[:port]`, the comparison used for origin pinning. Not `Url::origin`, whose
/// serialisation differs for non-special schemes, and not the full URL: a target legitimately
/// addresses many paths under one origin.
fn origin_of(url: &reqwest::Url) -> String {
    match url.port() {
        Some(port) => format!("{}://{}:{port}", url.scheme(), url.host_str().unwrap_or_default()),
        None => format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default()),
    }
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

/// The credentials a request will actually use, once it is settled where they came from. Held in
/// `Zeroizing` so the copies made on the way to the signer do not outlive the call in freed memory.
enum Resolved {
    S3 {
        region: String,
        access_key_id: Zeroizing<String>,
        secret_access_key: Zeroizing<String>,
    },
    Basic {
        username: Zeroizing<String>,
        password: Zeroizing<String>,
    },
}

/// Pick the credentials for this request, and enforce the origin pin when they are the stored
/// ones. An inline secret skips the pin deliberately: the caller already had that credential
/// before it called, so pinning it would restrict nothing that is not already lost.
fn resolve(auth: &AuthSpec, stored_json: Option<&str>, url: &reqwest::Url) -> Res<Resolved> {
    match auth {
        AuthSpec::S3Inline {
            region,
            access_key_id,
            secret_access_key,
        } => {
            return Ok(Resolved::S3 {
                region: region.clone(),
                access_key_id: Zeroizing::new(access_key_id.clone()),
                secret_access_key: Zeroizing::new(secret_access_key.clone()),
            })
        }
        AuthSpec::BasicInline { username, password } => {
            return Ok(Resolved::Basic {
                username: Zeroizing::new(username.clone()),
                password: Zeroizing::new(password.clone()),
            })
        }
        _ => {}
    }

    let stored_json = stored_json.ok_or("no stored credentials for this backup target")?;
    let stored: StoredCreds = serde_json::from_str(stored_json)
        .map_err(|e| format!("stored backup credentials unreadable: {e}"))?;
    // The one check that makes holding the credential here worth anything: it may only ever be
    // sent to the origin the user configured for this target.
    if origin_of(url) != stored.origin {
        return Err(format!(
            "refusing to authenticate a request to {}: this target's credentials are only for {}",
            origin_of(url),
            stored.origin
        ));
    }
    let secrets_json = stored.secrets.to_string();
    match auth {
        AuthSpec::S3 { region } => {
            let s: S3Secrets = serde_json::from_str(&secrets_json)
                .map_err(|e| format!("stored S3 credentials unreadable: {e}"))?;
            Ok(Resolved::S3 {
                region: region.clone(),
                access_key_id: Zeroizing::new(s.access_key_id.clone()),
                secret_access_key: Zeroizing::new(s.secret_access_key.clone()),
            })
        }
        _ => {
            let s: BasicSecrets = serde_json::from_str(&secrets_json)
                .map_err(|e| format!("stored WebDAV credentials unreadable: {e}"))?;
            Ok(Resolved::Basic {
                username: Zeroizing::new(s.username.clone()),
                password: Zeroizing::new(s.password.clone()),
            })
        }
    }
}

/// Turn an unauthenticated request into the exact one to send: the URL (with the canonical query
/// SigV4 signed, so the wire form and the signed form cannot diverge) and the full header list.
///
/// Separated from the sending so signing is testable with no network and no credential store.
fn prepare(
    auth: &AuthSpec,
    stored_json: Option<&str>,
    method: &str,
    url: &str,
    headers: Vec<(String, String)>,
    body: &[u8],
    stamp: &str,
) -> Res<(reqwest::Url, Vec<(String, String)>)> {
    let mut url = reqwest::Url::parse(url).map_err(|e| format!("backup url: {e}"))?;
    match resolve(auth, stored_json, &url)? {
        Resolved::S3 {
            region,
            access_key_id,
            secret_access_key,
        } => {
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
                    access_key_id: access_key_id.to_string(),
                    secret_access_key: secret_access_key.to_string(),
                    region,
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
        Resolved::Basic { username, password } => {
            let mut out = headers;
            let pair = Zeroizing::new(format!("{}:{}", *username, *password));
            out.push((
                "Authorization".to_string(),
                format!("Basic {}", B64.encode(pair.as_bytes())),
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

/// What a scheduled run did, into the app log.
///
/// The tick is emitted from here but the run happens in the webview, whose `console.warn` reaches
/// nobody: there is no JS log plugin, so a backup that runs with the window hidden and the vault
/// locked — which is the entire point of the feature — leaves no evidence anywhere a user could be
/// asked to look. This is the evidence.
///
/// Called even when nothing was due, because "it did nothing" and "it never ran" are otherwise
/// indistinguishable and have completely different causes. One short line per tick.
///
/// The summary is counts, vault ids and the provider's own error strings, the same material that
/// already went to the console. No URLs and no secrets.
#[tauri::command]
pub fn backup_run_report(summary: String, failed: bool) {
    if failed {
        log::warn!("scheduled backup: {summary}");
    } else {
        log::info!("scheduled backup: {summary}");
    }
}

/// Which credential store this machine offers, and therefore whether a backup can run while the
/// vault is locked. The caller turns it into a statement about behaviour, never into a question.
#[tauri::command]
pub fn backup_creds_tier() -> secure_store::Tier {
    secure_store::tier()
}

/// Store one target's secret fields, pinned to the origin they belong to. `origin` comes from the
/// endpoint or server URL the user just typed; requests to anywhere else are refused later.
#[tauri::command]
pub fn backup_creds_save(
    vault_id: String,
    target_id: String,
    origin: String,
    secrets: String,
) -> Res<()> {
    let parsed = reqwest::Url::parse(&origin).map_err(|e| format!("backup origin: {e}"))?;
    let record = StoredCreds {
        origin: origin_of(&parsed),
        secrets: serde_json::from_str(&secrets).map_err(|e| format!("backup credentials: {e}"))?,
    };
    let json = serde_json::to_string(&record).map_err(|e| format!("backup credentials: {e}"))?;
    secure_store::write(&account(&vault_id, &target_id), &json)
}

#[tauri::command]
pub fn backup_creds_remove(vault_id: String, target_id: String) -> Res<()> {
    secure_store::erase(&account(&vault_id, &target_id))
}

/// One authenticated request to a backup provider. The webview builds the request; the secret is
/// added here and never travels back, and only ever to the origin this target was saved with.
///
/// Main window only. A crate command is not gated by `capabilities/*.json` (those cover plugin
/// permissions), so without this check the always-on-top spotlight panel could drive it too, and
/// that window is deliberately the narrowest surface in the app.
#[tauri::command]
pub async fn backup_send(
    window: tauri::Window,
    vault_id: String,
    target_id: String,
    auth: AuthSpec,
    method: String,
    url: String,
    headers: HashMap<String, String>,
    body: Option<Vec<u8>>,
) -> Res<HttpReply> {
    if window.label() != crate::lifetime::MAIN {
        return Err("backups run from the main window only".into());
    }
    let stored = if auth.uses_stored_secret() {
        Some(
            secure_store::read(&account(&vault_id, &target_id))?
                .ok_or("no stored credentials for this backup target")?,
        )
    } else {
        None
    };
    let body = body.unwrap_or_default();
    let (url, headers) = prepare(
        &auth,
        stored.as_deref(),
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
    // Timeouts, because this runs unattended: without them one provider that accepts a connection
    // and then says nothing would hang the run, and the caller's in-flight latch with it, so every
    // vault's schedule would stop until the app restarted.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(600))
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

    /// A stored record: secrets plus the origin they are pinned to.
    fn stored(origin: &str, secrets: &str) -> String {
        format!(r#"{{"origin":"{origin}","secrets":{secrets}}}"#)
    }

    fn s3_secrets() -> String {
        stored(
            "https://s3.example.com",
            r#"{"accessKeyId":"AKIAIOSFODNN7EXAMPLE","secretAccessKey":"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}"#,
        )
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
            Some(s3_secrets().as_str()),
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
            Some(
            stored(
                "https://minio.example.com",
                r#"{"accessKeyId":"AKIA","secretAccessKey":"secret"}"#,
                )
                .as_str(),
            ),
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
            Some(
            stored(
                "https://minio.example.com:9000",
                r#"{"accessKeyId":"AKIA","secretAccessKey":"secret"}"#,
                )
                .as_str(),
            ),
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
            Some(
            stored(
                "http://localhost:8080",
                r#"{"username":"admin","password":"Bramble-test-123"}"#,
                )
                .as_str(),
            ),
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
            Some("not json"),
            "GET",
            "https://example.com/",
            vec![],
            b"",
            STAMP,
        )
        .unwrap_err();
        assert!(err.contains("backup credentials unreadable"), "{err}");
    }

    // The attack this whole arrangement exists to stop: the webview names the URL, so without a
    // pin it could ask for the credential to be attached to a request at its own server and read
    // it straight out of the log. Refusing to hand the secret back is not enough on its own.
    #[test]
    fn a_credential_is_refused_for_any_origin_but_its_own() {
        for (label, url) in [
            ("attacker host", "https://attacker.example/collect"),
            ("same host, other scheme", "http://cloud.example.com/dav/"),
            ("same host, other port", "https://cloud.example.com:8443/dav/"),
            ("subdomain", "https://cloud.example.com.attacker.example/dav/"),
            ("userinfo trick", "https://cloud.example.com@attacker.example/dav/"),
        ] {
            let err = prepare(
                &AuthSpec::Basic,
                Some(
            stored(
                    "https://cloud.example.com",
                    r#"{"username":"admin","password":"pw"}"#,
                    )
                    .as_str(),
                ),
                "GET",
                url,
                vec![],
                b"",
                STAMP,
            )
            .unwrap_err();
            assert!(err.contains("refusing to authenticate"), "{label}: {err}");
        }
    }

    #[test]
    fn a_credential_is_accepted_anywhere_under_its_own_origin() {
        for url in [
            "https://cloud.example.com/remote.php/dav/files/me/",
            "https://cloud.example.com/remote.php/dav/files/me/bramble/x.bramble",
        ] {
            assert!(
                prepare(
                    &AuthSpec::Basic,
                    Some(
            stored(
                        "https://cloud.example.com",
                        r#"{"username":"admin","password":"pw"}"#,
                        )
                        .as_str(),
                    ),
                    "PUT",
                    url,
                    vec![],
                    b"",
                    STAMP,
                )
                .is_ok(),
                "{url}"
            );
        }
    }

    // The no-credential-store fallback: the caller passes the secret it already unwrapped from the
    // vault, so there is nothing for a pin to protect, but the request must still be sent from
    // here because the webview cannot reach a provider.
    #[test]
    fn inline_credentials_need_no_pin_and_still_authenticate() {
        let (_, headers) = prepare(
            &AuthSpec::BasicInline {
                username: "admin".into(),
                password: "Bramble-test-123".into(),
            },
            None,
            "PUT",
            "https://anywhere.example/dav/x",
            vec![],
            b"",
            STAMP,
        )
        .unwrap();
        assert_eq!(
            header(&headers, "Authorization"),
            "Basic YWRtaW46QnJhbWJsZS10ZXN0LTEyMw=="
        );
    }

    #[test]
    fn a_stored_auth_spec_with_nothing_stored_is_an_error() {
        let err = prepare(
            &AuthSpec::Basic,
            None,
            "GET",
            "https://cloud.example.com/dav/",
            vec![],
            b"",
            STAMP,
        )
        .unwrap_err();
        assert!(err.contains("no stored credentials"), "{err}");
    }

    #[test]
    fn the_s3_path_is_pinned_too() {
        let err = prepare(
            &AuthSpec::S3 {
                region: "us-east-1".into(),
            },
            Some(s3_secrets().as_str()),
            "GET",
            "https://attacker.example/b/k",
            vec![],
            b"",
            STAMP,
        )
        .unwrap_err();
        assert!(err.contains("refusing to authenticate"), "{err}");
    }

    /// The signer against a real S3 implementation, which is the only check that matters: our own
    /// vectors prove the Rust and TypeScript signers agree with each other, not that either agrees
    /// with a server. MinIO validates SigV4 strictly, so a canonicalisation mistake fails here and
    /// nowhere else. It also exercises the invariant that the request sent is the request signed,
    /// since reqwest, not the test, decides what finally goes on the wire.
    ///
    ///   docker compose up -d
    ///   cargo test --manifest-path packages/platform-desktop/src-tauri/Cargo.toml -- --ignored
    #[test]
    #[ignore = "needs the MinIO from docker compose"]
    fn signs_a_request_minio_accepts() {
        let base = std::env::var("BRAMBLE_IT_S3").unwrap_or("http://localhost:9000".into());
        let bucket = std::env::var("BRAMBLE_IT_S3_BUCKET").unwrap_or("bramble-test".into());
        let stored = stored(
            &base,
            r#"{"accessKeyId":"bramble","secretAccessKey":"bramble-test-secret"}"#,
        );
        let auth = AuthSpec::S3 {
            region: "us-east-1".into(),
        };
        let key = format!("{base}/{bucket}/it-rust-signer.bramble");
        let body = b"sealed vault bytes".to_vec();

        let send = |method: &str, url: &str, body: Vec<u8>| {
            let (url, headers) = prepare(
                &auth,
                Some(stored.as_str()),
                method,
                url,
                vec![(
                    "content-type".to_string(),
                    "application/octet-stream".to_string(),
                )],
                &body,
                &amz_date(),
            )
            .expect("prepare");
            let method = reqwest::Method::from_bytes(method.as_bytes()).unwrap();
            tauri::async_runtime::block_on(async move {
                let mut req = reqwest::Client::new().request(method, url);
                for (k, v) in headers {
                    req = req.header(k, v);
                }
                let res = req.body(body).send().await.expect("minio reachable");
                (res.status().as_u16(), res.bytes().await.unwrap().to_vec())
            })
        };

        let (status, _) = send("PUT", &key, body.clone());
        assert_eq!(status, 200, "MinIO rejected the signed PUT");
        let (status, got) = send("GET", &key, vec![]);
        assert_eq!(status, 200);
        assert_eq!(got, body, "the bytes came back changed");
        let (status, _) = send("DELETE", &key, vec![]);
        assert_eq!(status, 204, "delete should succeed");
    }

    #[test]
    fn a_stamp_is_the_shape_sigv4_requires() {
        let stamp = amz_date();
        assert_eq!(stamp.len(), 16, "{stamp}");
        assert!(stamp.ends_with('Z') && stamp.contains('T'), "{stamp}");
        assert!(stamp[..8].chars().all(|c| c.is_ascii_digit()), "{stamp}");
    }
}
