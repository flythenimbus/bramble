//! Outbound HTTP on behalf of the webview, which cannot make these requests itself.
//!
//! `tauri://localhost` is granted CORS by nothing: not an S3 endpoint, not a WebDAV server, and
//! not an API that sends no CORS headers at all. So a request to a third party is sent from here,
//! where there is no origin to refuse and no browser to enforce one.
//!
//! Every request this process makes goes through `send`, so the two rules hold once rather than
//! per caller. Both are the same ones `@core/adapters/http` documents for the JS side:
//!
//! - **No ambient cookies.** The credential is the header the caller set and nothing else. The
//!   `cookies` feature is deliberately absent from the reqwest dependency, so there is no cookie
//!   store to accidentally enable. An open browser session for the same host has already
//!   outranked an Authorization header here once (1255ab7b).
//! - **No redirect following.** A redirect out of an API call means the session was rejected and
//!   the destination is an HTML login page; for a signed request it also moves the request off
//!   the URL that was signed. A 3xx is returned as itself.
//!
//! See docs/email-aliases.md and docs/cloud-storage-backups.md.

use std::collections::HashMap;
use std::time::Duration;

use serde::Serialize;

type Res<T> = Result<T, String>;

#[derive(Serialize)]
pub struct HttpReply {
    pub status: u16,
    /// Whole body. An API reply, a listing, or one vault blob, never a stream.
    pub body: Vec<u8>,
}

/// Time to get a connection, everywhere. A host that accepts nothing fails fast whatever the
/// caller is doing.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// An API call, with somebody waiting on it.
const API_TIMEOUT: Duration = Duration::from_secs(60);

/// A vault blob over a home connection's upload. Long because a backup runs unattended, and
/// bounded at all because without it one provider that accepts a connection and then says nothing
/// would hang the run, and the caller's in-flight latch with it, until the app restarted.
pub const UPLOAD_TIMEOUT: Duration = Duration::from_secs(600);

/// Send one request and read the whole reply.
///
/// Callers pass a parsed `Url` and the final header list, so a signed request cannot diverge
/// between what was signed and what goes out.
pub async fn send(
    method: &str,
    url: reqwest::Url,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    timeout: Duration,
) -> Res<HttpReply> {
    send_body(method, url, headers, reqwest::Body::from(body), timeout).await
}

/// The timeout for a streamed upload of `size` bytes. Scaled, because a fixed one would cut off a
/// large backup on a slow connection however healthy it was: ten minutes, plus a second for every
/// 64 KiB, a floor no working home uplink is under.
pub fn upload_timeout_for(size: u64) -> Duration {
    UPLOAD_TIMEOUT + Duration::from_secs(size / (64 * 1024))
}

/// `send`, with any body: a buffer, or a stream read as the request goes out.
pub async fn send_body(
    method: &str,
    url: reqwest::Url,
    headers: Vec<(String, String)>,
    body: reqwest::Body,
    timeout: Duration,
) -> Res<HttpReply> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(timeout)
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
        .map_err(|e| format!("request failed: {e}"))?;
    let status = res.status().as_u16();
    let body = res
        .bytes()
        .await
        .map_err(|e| format!("response failed: {e}"))?
        .to_vec();
    Ok(HttpReply { status, body })
}

/// One request for the webview, with the caller's own credentials in `headers`.
///
/// Unlike `backup::backup_send` this reads no stored secret and pins no origin: the credential is
/// one the webview already holds (an alias provider's API key, unwrapped from the open vault), so
/// there is nothing here that the caller could not send itself if CORS allowed it. What it gains
/// is reach, which is why it is still restricted to the main window.
#[tauri::command]
pub async fn http_send(
    window: tauri::Window,
    method: String,
    url: String,
    headers: HashMap<String, String>,
    body: Option<Vec<u8>>,
) -> Res<HttpReply> {
    // A crate command is not gated by `capabilities/*.json` (those cover plugin permissions), so
    // without this check the always-on-top spotlight panel could reach any host on the internet,
    // and that window is deliberately the narrowest surface in the app.
    if window.label() != crate::lifetime::MAIN {
        return Err("outbound requests run from the main window only".into());
    }
    let url = reqwest::Url::parse(&url).map_err(|e| format!("http url: {e}"))?;
    send(
        &method,
        url,
        headers.into_iter().collect(),
        body.unwrap_or_default(),
        API_TIMEOUT,
    )
    .await
}
