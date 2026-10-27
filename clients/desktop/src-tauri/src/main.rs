// Prevents an additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Before Tauri, deliberately. The uninstaller calls this while the binary still exists, and
    // it must not raise a window, load a vault or take the single-instance lock on its way out.
    // See src/secure_store.rs for why the uninstaller cannot do this job itself.
    #[cfg(windows)]
    if std::env::args().any(|a| a == "--purge-secrets") {
        let gone = bramble_desktop_lib::purge_secrets();
        // Nothing reads this (the uninstaller runs it windowless) beyond the exit code, which is
        // always success: a secret that will not delete is not a reason to fail an uninstall.
        eprintln!("bramble: removed {gone} stored credential(s)");
        return;
    }

    bramble_desktop_lib::run();
}
