//! Secrets that belong in the OS credential store rather than a file.
//!
//! The pairing identity was the first (see `pairing`), and device sync brings two more: the
//! Noise static keypair that authenticates this device to the sync group, and the Ed25519
//! seed it signs roster entries with. Mobile keeps the same two in the Keychain/Keystore for
//! the same reason: only their PUBLIC halves ever leave the device, so the private halves have
//! no business sitting in a readable file next to the vault.
//!
//! Reads are cached, and that is not an optimisation. macOS ties a keychain item's ACL to the
//! reading binary's code signature, so on any build whose signature the keychain does not
//! recognise every read is a password prompt; reading per operation turned a working feature
//! into a wall of them once already. An absent value is cached too, since that is just as
//! stable a fact as a present one.

use std::{collections::HashMap, sync::Mutex};

type Res<T> = Result<T, String>;

/// Shared with `pairing`, which was here first.
const SERVICE: &str = "app.bramble.desktop";

/// `None` means never looked up; `Some(None)` means looked up and absent.
static CACHE: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

pub fn entry(account: &str) -> Res<keyring::Entry> {
    keyring::Entry::new(SERVICE, account).map_err(|e| format!("credential store unavailable: {e}"))
}

fn cached(account: &str) -> Option<Option<String>> {
    CACHE.lock().unwrap().as_ref()?.get(account).cloned()
}

fn remember(account: &str, value: Option<String>) {
    CACHE
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(account.to_string(), value);
}

pub fn read(account: &str) -> Res<Option<String>> {
    if let Some(hit) = cached(account) {
        return Ok(hit);
    }
    #[cfg(test)]
    let found: Option<String> = None;
    #[cfg(not(test))]
    let found = match entry(account)?.get_password() {
        Ok(raw) => Some(raw),
        Err(keyring::Error::NoEntry) => None,
        Err(e) => return Err(format!("credential store read: {e}")),
    };
    remember(account, found.clone());
    Ok(found)
}

pub fn write(account: &str, value: &str) -> Res<()> {
    #[cfg(not(test))]
    entry(account)?
        .set_password(value)
        .map_err(|e| format!("credential store write: {e}"))?;
    remember(account, Some(value.to_string()));
    Ok(())
}

pub fn erase(account: &str) -> Res<()> {
    #[cfg(not(test))]
    match entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(format!("credential store delete: {e}")),
    }
    remember(account, None);
    Ok(())
}

// ---- commands ----
//
// Keys are namespaced by the caller (`sync.deviceKeypair`, ...). The webview never sees a
// value it did not put there itself, and the vault's own keys are not reachable through here.
//
// Except for the reserved names below, which the webview may not touch at all: they hold
// secrets this process owns and uses on the webview's behalf, so handing one back would defeat
// the point of keeping it here. Backup provider credentials are the first (see `backup`): the
// webview asks for a request to be SENT, never for the credential that authenticates it.

const RESERVED: [&str; 1] = [crate::backup::CREDS_PREFIX];

fn reserved(key: &str) -> Res<()> {
    if RESERVED.iter().any(|p| key.starts_with(p)) {
        return Err(format!("{key} is not readable or writable from here"));
    }
    Ok(())
}

#[tauri::command]
pub fn secure_get(key: String) -> Res<Option<String>> {
    reserved(&key)?;
    read(&key)
}

#[tauri::command]
pub fn secure_set(key: String, value: String) -> Res<()> {
    reserved(&key)?;
    write(&key, &value)
}

#[tauri::command]
pub fn secure_delete(key: String) -> Res<()> {
    reserved(&key)?;
    erase(&key)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cache is process-global, so these must not interleave.
    fn setup() -> std::sync::MutexGuard<'static, ()> {
        let guard = crate::pairing::test_lock();
        *CACHE.lock().unwrap() = None;
        guard
    }

    #[test]
    fn a_value_round_trips() {
        let _g = setup();
        assert_eq!(read("k").unwrap(), None);
        write("k", "v").unwrap();
        assert_eq!(read("k").unwrap(), Some("v".into()));
    }

    #[test]
    fn erasing_removes_it() {
        let _g = setup();
        write("k", "v").unwrap();
        erase("k").unwrap();
        assert_eq!(read("k").unwrap(), None);
    }

    #[test]
    fn keys_do_not_collide() {
        let _g = setup();
        write("sync.deviceKeypair", "a").unwrap();
        write("sync.signingKey", "b").unwrap();
        assert_eq!(read("sync.deviceKeypair").unwrap(), Some("a".into()));
        assert_eq!(read("sync.signingKey").unwrap(), Some("b".into()));
    }

    // The webview can drive these commands, so a compromised one must not be able to ask for a
    // backup provider credential: this process holds it precisely so that JS never can.
    #[test]
    fn reserved_accounts_are_refused_through_the_commands() {
        let _g = setup();
        write("backup.creds:v1:t1", "secret").unwrap();
        assert!(secure_get("backup.creds:v1:t1".into()).is_err());
        assert!(secure_set("backup.creds:v1:t1".into(), "other".into()).is_err());
        assert!(secure_delete("backup.creds:v1:t1".into()).is_err());
        // ...and the value is untouched by the refused writes.
        assert_eq!(read("backup.creds:v1:t1").unwrap(), Some("secret".into()));
        // Everything else still works.
        assert!(secure_set("sync.deviceKeypair".into(), "kp".into()).is_ok());
        assert_eq!(
            secure_get("sync.deviceKeypair".into()).unwrap(),
            Some("kp".into())
        );
    }

    #[test]
    fn an_absent_key_is_cached_too() {
        // The regression that produced a run of macOS password prompts: caching only hits
        // meant a missing value went back to the credential store on every single call.
        let _g = setup();
        for _ in 0..5 {
            assert_eq!(read("never-set").unwrap(), None);
        }
        let cache = CACHE.lock().unwrap();
        assert!(
            cache.as_ref().unwrap().contains_key("never-set"),
            "an absent value must be remembered as absent"
        );
    }
}
