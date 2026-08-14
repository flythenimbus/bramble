//! AWS Signature Version 4 signing for S3-compatible backup targets.
//!
//! The desktop shell uploads backups from Rust rather than from its webview: the webview's
//! origin is `tauri://localhost`, and no S3 endpoint or WebDAV server sends it a CORS grant,
//! so a request made there fails before it reaches the network. Signing therefore has to
//! happen here, next to the credential, which lives in the OS credential store and never
//! enters JavaScript. See docs/cloud-storage-backups.md.
//!
//! This mirrors `packages/core/src/backup/sigv4.ts` (WebCrypto, used by the extension and
//! mobile). Two implementations of one frozen 2012 specification is a tolerable duplication,
//! unlike two implementations of our own object naming or retention, which stay in TS and are
//! shared by every platform. The tests below pin both to the same vectors: AWS's published
//! reference signature, plus cases cross-checked against the TS signer.
//!
//! The caller supplies the URI path exactly as it will appear on the wire and the DECODED
//! query pairs; the result carries the canonical query string back, so the request that goes
//! out is byte-for-byte the one that was signed.

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

pub struct S3Credentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub region: String,
}

pub struct SignRequest<'a> {
    pub method: &'a str,
    pub host: &'a str,
    /// Already URI-encoded, slashes intact, e.g. `/bucket/bramble/backup.bramble`.
    pub uri_path: &'a str,
    /// Decoded pairs. The signer encodes and sorts them, and hands back the exact string to send.
    pub query: &'a [(String, String)],
    /// Extra headers to sign (e.g. `content-type`). Host and the two `x-amz-*` values are added here.
    pub headers: &'a [(String, String)],
    pub body: &'a [u8],
}

pub struct SignedRequest {
    /// The canonical query string, which is also the one the request must be sent with.
    pub canonical_query: String,
    /// Headers to attach, including `Authorization`.
    pub headers: Vec<(String, String)>,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    // HMAC accepts a key of any length, so this cannot fail for any input we produce.
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

/// AWS uri-encoding: unreserved characters (A-Za-z0-9-._~) pass through, everything else is
/// percent-encoded byte by byte. Path slashes survive when `encode_slash` is false.
pub fn uri_encode(input: &str, encode_slash: bool) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '.' | '_' | '~') {
            out.push(ch);
        } else if ch == '/' && !encode_slash {
            out.push('/');
        } else {
            let mut buf = [0u8; 4];
            for b in ch.encode_utf8(&mut buf).as_bytes() {
                out.push_str(&format!("%{b:02X}"));
            }
        }
    }
    out
}

fn canonical_query(pairs: &[(String, String)]) -> String {
    let mut encoded: Vec<(String, String)> = pairs
        .iter()
        .map(|(k, v)| (uri_encode(k, true), uri_encode(v, true)))
        .collect();
    encoded.sort();
    encoded
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&")
}

/// Sign a request. `amz_date` is the `YYYYMMDDTHHMMSSZ` stamp, passed in rather than read from
/// the clock so callers (and tests) control it; the date scope is derived from it.
pub fn sign_s3(
    req: &SignRequest,
    creds: &S3Credentials,
    service: &str,
    amz_date: &str,
) -> SignedRequest {
    let date_stamp = &amz_date[..8];
    let payload_hash = sha256_hex(req.body);

    // Sorted by name, which is what the canonical form requires; BTreeMap also collapses a
    // caller that passes the same header twice, as the header set would anyway.
    let mut sign_headers: std::collections::BTreeMap<String, String> = [
        ("host".to_string(), req.host.to_string()),
        ("x-amz-content-sha256".to_string(), payload_hash.clone()),
        ("x-amz-date".to_string(), amz_date.to_string()),
    ]
    .into_iter()
    .collect();
    for (k, v) in req.headers {
        sign_headers.insert(k.to_lowercase(), v.clone());
    }

    // Each entry ends with "\n"; the join below adds one more before signed_headers, producing
    // the blank line SigV4 requires after the headers block.
    let canonical_headers: String = sign_headers
        .iter()
        .map(|(k, v)| format!("{k}:{}\n", v.trim()))
        .collect();
    let signed_headers = sign_headers.keys().cloned().collect::<Vec<_>>().join(";");
    let query = canonical_query(req.query);

    let canonical_request = [
        req.method,
        req.uri_path,
        &query,
        &canonical_headers,
        &signed_headers,
        &payload_hash,
    ]
    .join("\n");

    let scope = format!("{date_stamp}/{}/{service}/aws4_request", creds.region);
    let string_to_sign = [
        "AWS4-HMAC-SHA256",
        amz_date,
        &scope,
        &sha256_hex(canonical_request.as_bytes()),
    ]
    .join("\n");

    let k_date = hmac(
        format!("AWS4{}", creds.secret_access_key).as_bytes(),
        date_stamp,
    );
    let k_region = hmac(&k_date, &creds.region);
    let k_service = hmac(&k_region, service);
    let k_signing = hmac(&k_service, "aws4_request");
    let signature = hex(&hmac(&k_signing, &string_to_sign));

    let mut headers: Vec<(String, String)> = req.headers.to_vec();
    headers.push(("x-amz-content-sha256".into(), payload_hash));
    headers.push(("x-amz-date".into(), amz_date.into()));
    headers.push((
        "Authorization".into(),
        format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
            creds.access_key_id
        ),
    ));
    SignedRequest {
        canonical_query: query,
        headers,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn creds() -> S3Credentials {
        S3Credentials {
            access_key_id: "AKIAIOSFODNN7EXAMPLE".into(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".into(),
            region: "us-east-1".into(),
        }
    }

    fn signature_of(headers: &[(String, String)]) -> String {
        let auth = headers
            .iter()
            .find(|(k, _)| k == "Authorization")
            .map(|(_, v)| v.clone())
            .expect("signed requests carry an Authorization header");
        auth.rsplit("Signature=").next().unwrap().to_string()
    }

    fn header<'a>(headers: &'a [(String, String)], name: &str) -> &'a str {
        headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
            .unwrap_or_default()
    }

    /// AWS's own "Signature Calculations: GET Object" example, which is also the vector the TS
    /// signer is pinned to. Both implementations agreeing with the published value is the point.
    /// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
    #[test]
    fn matches_the_aws_get_object_reference_signature() {
        let signed = sign_s3(
            &SignRequest {
                method: "GET",
                host: "examplebucket.s3.amazonaws.com",
                uri_path: "/test.txt",
                query: &[],
                headers: &[("range".to_string(), "bytes=0-9".to_string())],
                body: b"",
            },
            &creds(),
            "s3",
            "20130524T000000Z",
        );
        assert_eq!(
            signature_of(&signed.headers),
            "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
        let auth = header(&signed.headers, "Authorization");
        assert!(auth.contains("Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request"));
        assert!(auth.contains("SignedHeaders=host;range;x-amz-content-sha256;x-amz-date"));
        assert_eq!(
            header(&signed.headers, "x-amz-content-sha256"),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn uri_encodes_per_aws_rules() {
        assert_eq!(uri_encode("test$file.text", true), "test%24file.text");
        assert_eq!(uri_encode("/a b/c", false), "/a%20b/c");
        assert_eq!(uri_encode("/a b/c", true), "%2Fa%20b%2Fc");
        assert_eq!(uri_encode("aA0-._~", true), "aA0-._~");
        // Multi-byte characters encode per UTF-8 byte, not per character.
        assert_eq!(uri_encode("é", true), "%C3%A9");
    }

    // Cross-checks against the TS signer for what the AWS vector does not exercise: a real body,
    // a signed content-type, and a query string. The expected values were produced by
    // `packages/core/src/backup/sigv4.ts`, so a divergence between the two implementations fails
    // here rather than at a provider.
    fn b2_creds() -> S3Credentials {
        S3Credentials {
            region: "us-west-002".into(),
            ..creds()
        }
    }

    #[test]
    fn agrees_with_the_ts_signer_on_a_put_with_a_body() {
        let signed = sign_s3(
            &SignRequest {
                method: "PUT",
                host: "s3.example.com",
                uri_path: "/mybucket/bramble/bramble-2026-08-14T10-11-12Z-abcd1234.bramble",
                query: &[],
                headers: &[(
                    "content-type".to_string(),
                    "application/octet-stream".to_string(),
                )],
                body: b"sealed vault bytes",
            },
            &b2_creds(),
            "s3",
            "20260814T101112Z",
        );
        assert_eq!(
            signature_of(&signed.headers),
            "d3f95ee6c92d5d0565da74b00441d12443bc10c1757680746766041923bf83f9"
        );
    }

    #[test]
    fn agrees_with_the_ts_signer_on_a_list_query() {
        let signed = sign_s3(
            &SignRequest {
                method: "GET",
                host: "s3.example.com",
                uri_path: "/mybucket",
                query: &[
                    ("list-type".to_string(), "2".to_string()),
                    ("prefix".to_string(), "bramble/sub dir".to_string()),
                ],
                headers: &[],
                body: b"",
            },
            &b2_creds(),
            "s3",
            "20260814T101112Z",
        );
        assert_eq!(
            signature_of(&signed.headers),
            "12298afe7ab9cedfe97718ba079224eb453fea81f57fcd8912b6061d51281a1e"
        );
    }

    #[test]
    fn sorts_and_encodes_the_query_the_caller_must_send() {
        let signed = sign_s3(
            &SignRequest {
                method: "GET",
                host: "s3.example.com",
                uri_path: "/bucket",
                query: &[
                    ("prefix".to_string(), "bramble/sub dir".to_string()),
                    ("list-type".to_string(), "2".to_string()),
                ],
                headers: &[],
                body: b"",
            },
            &creds(),
            "s3",
            "20260814T101112Z",
        );
        assert_eq!(
            signed.canonical_query,
            "list-type=2&prefix=bramble%2Fsub%20dir"
        );
    }
}
