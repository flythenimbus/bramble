use std::{env, fs, path::PathBuf};

/// Make sure the sidecar exists before tauri-build looks for it.
///
/// `externalBin` is validated by tauri-build on EVERY cargo invocation in this crate, and the
/// proxy it names is a binary in this same crate. So without this, a clean checkout cannot run
/// `cargo test`, `cargo clippy` or even `cargo check` until something has already produced it,
/// which is a circular and thoroughly confusing failure. An empty placeholder satisfies the
/// check; scripts/stage-proxy.mjs writes the real binary over it before anything is bundled.
///
/// Named for the triple being built rather than the host's, because tauri-build looks for the
/// one matching its target: a universal build compiles each arch separately, and cross-compiling
/// the proxy is exactly the step that has to run before its own sidecar can exist.
fn ensure_proxy_placeholder() {
    let triple = env::var("TARGET").unwrap_or_else(|_| "aarch64-apple-darwin".into());
    let path = PathBuf::from(format!("binaries/bramble-proxy-{triple}"));
    if path.exists() {
        return;
    }
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::write(&path, b"");
}

fn main() {
    ensure_proxy_placeholder();
    // The icon set is embedded by `generate_context!` when the crate compiles, and cargo does
    // not otherwise treat it as an input: regenerating icons then rebuilding is a no-op, and
    // the binary keeps serving the previous artwork with nothing to show it.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
