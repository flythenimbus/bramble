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

use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use serde::Serialize;
use zeroize::Zeroizing;

type Res<T> = Result<T, String>;

/// Shared with `pairing`, which was here first.
const SERVICE: &str = "app.bramble.desktop";

/// Which store is answering on this machine.
///
/// A ladder rather than a yes/no, because Linux has two mechanisms and a session may have either,
/// both, or neither, and because the difference is visible to the user as *when their backups
/// run*. The app climbs it and never asks: choosing between these needs knowledge of what a given
/// distribution's Secret Service guarantees versus what a kernel keyring does, which is not a
/// judgement to hand to someone who just wants their vault backed up. See
/// docs/cloud-storage-backups.md.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    /// The platform's own credential store: Keychain, Credential Manager, or Secret Service.
    Os,
    /// Linux kernel keyutils. Not at-rest storage: the key is linked into the session keyring and
    /// the per-UID persistent keyring, so it outlives an app restart and even a logout (subject to
    /// the persistent keyring's expiry, refreshed on every access), but not a reboot. The answer
    /// for sessions with no Secret Service on the bus: minimal window managers, headless boxes.
    Kernel,
    /// Nothing usable. Callers fall back to keeping secrets under the vault key.
    None,
}

/// Resolved once: probing costs a round trip to the store, and the answer does not change while
/// the process runs (a keyring appearing mid-session is rare enough to be worth a restart).
static TIER: OnceLock<Tier> = OnceLock::new();

/// Build an entry against a specific tier's backend.
fn entry_for(tier: Tier, account: &str) -> Res<keyring::Entry> {
    let builder = match tier {
        #[cfg(target_os = "linux")]
        Tier::Os => keyring::secret_service::default_credential_builder(),
        #[cfg(target_os = "linux")]
        Tier::Kernel => keyring::keyutils::default_credential_builder(),
        #[cfg(not(target_os = "linux"))]
        Tier::Os | Tier::Kernel => {
            return keyring::Entry::new(SERVICE, account)
                .map_err(|e| format!("credential store unavailable: {e}"))
        }
        Tier::None => return Err("no credential store on this system".into()),
    };
    #[allow(unreachable_code)]
    {
        let credential = builder
            .build(None, SERVICE, account)
            .map_err(|e| format!("credential store unavailable: {e}"))?;
        Ok(keyring::Entry::new_with_credential(credential))
    }
}

/// Does this backend answer at all? Reads a name that is never written, so nothing is created:
/// "no such entry" is the healthy response, and anything else means the store is not usable.
fn probes_ok(tier: Tier) -> bool {
    match entry_for(tier, PROBE).map(|e| e.get_password()) {
        Ok(Ok(_)) | Ok(Err(keyring::Error::NoEntry)) => true,
        _ => false,
    }
}

/// A name that is never written, used only to ask a backend whether it is there.
const PROBE: &str = ".probe";

/// The best store this machine offers, resolved on first use.
pub fn tier() -> Tier {
    *TIER.get_or_init(|| {
        for candidate in [Tier::Os, Tier::Kernel] {
            // On anything but Linux the two candidates are the same backend, so one probe decides.
            if !cfg!(target_os = "linux") && candidate == Tier::Kernel {
                break;
            }
            if probes_ok(candidate) {
                log::info!("credential store: {candidate:?}");
                return candidate;
            }
        }
        log::warn!("no credential store available; secrets stay under the vault key");
        Tier::None
    })
}

/// How long a cached value stays usable, for accounts that get one.
///
/// Most accounts here are device identity, read constantly and cached for the process lifetime
/// because that is what the prompt problem above demands. Backup provider credentials are
/// different: they are read in bursts (a snapshot is a PUT, a listing and some deletes), and
/// keeping them resident between runs means a plaintext cloud credential sits in this process's
/// memory for days with no run in sight. A short window keeps a burst to one keychain read
/// without that. See docs/cloud-storage-backups.md, "Handling the secret in memory".
const BURST_TTL: Duration = Duration::from_secs(60);

fn ttl_for(account: &str) -> Option<Duration> {
    account
        .starts_with(crate::backup::CREDS_PREFIX)
        .then_some(BURST_TTL)
}

/// `None` means never looked up; `Some(None)` means looked up and absent. Values are zeroized
/// when they are replaced or evicted, so an expired credential does not linger in freed memory.
type Entry = (Option<Zeroizing<String>>, Instant);
static CACHE: Mutex<Option<HashMap<String, Entry>>> = Mutex::new(None);

pub fn entry(account: &str) -> Res<keyring::Entry> {
    entry_for(tier(), account)
}

/// A cache hit, unless this account has a TTL and the entry is past it. An expired entry is
/// dropped on the way out, which zeroizes the value rather than leaving it to be overwritten
/// whenever the account is next read.
fn cached(account: &str) -> Option<Option<String>> {
    let mut guard = CACHE.lock().unwrap();
    let map = guard.as_mut()?;
    let (value, stored_at) = map.get(account)?;
    if ttl_for(account).is_some_and(|ttl| stored_at.elapsed() > ttl) {
        map.remove(account);
        return None;
    }
    Some(value.as_ref().map(|v| v.to_string()))
}

fn remember(account: &str, value: Option<String>) {
    CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(
        account.to_string(),
        (value.map(Zeroizing::new), Instant::now()),
    );
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

    // Device identity is read constantly and stays cached for the process lifetime, which is what
    // keeps macOS from prompting. A backup credential is read in bursts and would otherwise sit in
    // memory for days between runs, so only that prefix expires.
    #[test]
    fn only_backup_credentials_expire_from_the_cache() {
        assert!(ttl_for("backup.creds:v1:t1").is_some());
        assert!(ttl_for("sync.deviceKeypair").is_none());
        assert!(ttl_for("extension-pairing-identity").is_none());
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
