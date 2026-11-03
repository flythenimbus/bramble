//! Windows: Windows Hello's own key (`KeyCredentialManager`), so the unlock is bound to the Hello
//! check cryptographically rather than to a yes/no answer. Hello signs a fixed per-vault challenge
//! with a key that never leaves the TPM; the signature goes through the same HKDF as a security
//! key's hmac-secret to become the KEK that wraps the VEK, with the same verifier, so a slot here
//! is a webauthn slot with Hello standing in for the authenticator (vault_crypto does the crypto).
//!
//! This needs the signature to come out the same every time. Hello keys are RSA, PKCS#1 v1.5 signing
//! is deterministic, and a Windows 11 check confirmed it (docs/desktop-biometric-unlock.md). Were it
//! ever not, every unlock would fail the verifier and report the gate invalidated: the safe failure.

use std::{thread, time::Duration};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use windows::{
    core::{w, Array, HSTRING, PCWSTR},
    Security::{
        Credentials::{
            KeyCredential, KeyCredentialCreationOption, KeyCredentialManager, KeyCredentialStatus,
        },
        Cryptography::CryptographicBuffer,
    },
    Win32::UI::WindowsAndMessaging::{
        FindWindowW, IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE,
    },
};
use zeroize::Zeroizing;

use super::{BioError, BioResult, Status};

/// Where the wrapped key and its challenge live: Credential Manager, under the app's own service so
/// the uninstaller's sweep (`secure_store::purge_all`) takes them too. Nothing in it opens the
/// vault without a Hello signature.
const SERVICE: &str = "app.bramble.desktop";
/// Binds the verifier to this use, apart from any vault slot's.
const MAGIC: &[u8] = b"BRAMBLE-HELLO-1";
const CHALLENGE_LEN: usize = 32;

/// What `arm` keeps per vault. The challenge and slot id are not secret; the rest is the
/// wrapped VEK, useless without Hello's signature over the challenge.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sealed {
    challenge: String,
    slot_id: String,
    verifier: String,
    wrap_iv: String,
    wrapped_vek: String,
}

/// One Hello key per vault, so disabling one vault's gate leaves the others alone.
fn key_name(vault_id: &str) -> HSTRING {
    HSTRING::from(format!("app.bramble.desktop vault {vault_id}"))
}

fn entry(vault_id: &str) -> BioResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, &format!("biometric:{vault_id}")).map_err(store_failure)
}

fn store_failure(e: keyring::Error) -> BioError {
    BioError::new("failed", format!("Credential Manager: {e}"))
}

fn win_failure(e: windows::core::Error) -> BioError {
    BioError::new("failed", format!("Windows Hello: {}", e.message()))
}

pub fn status() -> Status {
    // True once Hello is set up on this account, PIN included.
    let supported = KeyCredentialManager::IsSupportedAsync()
        .and_then(|op| op.join())
        .unwrap_or(false);
    Status {
        available: supported,
        biometry_type: if supported { "windowsHello" } else { "" },
        biometry_enrolled: supported,
    }
}

pub fn has(vault_id: &str) -> bool {
    entry(vault_id)
        .and_then(|e| e.get_password().map_err(store_failure))
        .is_ok()
}

/// Hello always accepts its PIN, so there is no gate to choose and `allow_passcode` is ignored.
pub fn arm(vault_id: &str, _allow_passcode: bool) -> BioResult<()> {
    let credential = open_or_create(vault_id)?;
    let mut challenge = [0u8; CHALLENGE_LEN];
    getrandom::fill(&mut challenge).map_err(|e| BioError::new("failed", e.to_string()))?;
    let signature = sign(&credential, &challenge)?;
    let slot_id =
        vault_crypto::generate_slot_id().map_err(|e| BioError::new("failed", e.to_string()))?;
    let blob =
        vault_crypto::wrap_vek_webauthn(B64.encode(&*signature), slot_id.clone(), MAGIC.to_vec())
            .map_err(|e| BioError::new("failed", e.to_string()))?;
    let sealed = Sealed {
        challenge: B64.encode(challenge),
        slot_id,
        verifier: blob.verifier,
        wrap_iv: blob.wrap_iv,
        wrapped_vek: blob.wrapped_vek,
    };
    let json =
        serde_json::to_string(&sealed).map_err(|e| BioError::new("failed", e.to_string()))?;
    entry(vault_id)?.set_password(&json).map_err(store_failure)
}

pub fn unlock(vault_id: &str, _allow_passcode: bool) -> BioResult<()> {
    let json = match entry(vault_id)?.get_password() {
        Ok(json) => json,
        Err(keyring::Error::NoEntry) => {
            return Err(BioError::new("no-secret", "No key stored for this vault"))
        }
        Err(e) => return Err(store_failure(e)),
    };
    let sealed: Sealed = serde_json::from_str(&json)
        .map_err(|_| BioError::new("failed", "The stored key is unreadable"))?;
    let challenge = B64
        .decode(&sealed.challenge)
        .map_err(|_| BioError::new("failed", "The stored key is unreadable"))?;

    let found = KeyCredentialManager::OpenAsync(&key_name(vault_id))
        .and_then(|op| op.join())
        .map_err(win_failure)?;
    if found.Status().map_err(win_failure)? != KeyCredentialStatus::Success {
        // The Hello key is gone (Hello reset, or removed in Settings): nothing can sign for this
        // vault again, so the gate goes.
        let _ = delete(vault_id);
        return Err(BioError::new(
            "invalidated",
            "Windows Hello was reset; the cached key was discarded",
        ));
    }
    let credential = found.Credential().map_err(win_failure)?;
    let signature = sign(&credential, &challenge)?;
    let opened = vault_crypto::unwrap_vek_webauthn(
        B64.encode(&*signature),
        sealed.slot_id,
        sealed.verifier,
        sealed.wrap_iv,
        sealed.wrapped_vek,
        MAGIC.to_vec(),
    )
    .map_err(|e| BioError::new("failed", e.to_string()))?;
    if opened {
        Ok(())
    } else {
        // Hello signed, but not to the key this vault was armed with: a replaced Hello key.
        let _ = delete(vault_id);
        Err(BioError::new(
            "invalidated",
            "Windows Hello's key changed; the cached key was discarded",
        ))
    }
}

pub fn delete(vault_id: &str) -> BioResult<()> {
    // Best effort on the Hello key: a stale one costs nothing and can't open anything alone.
    let _ = KeyCredentialManager::DeleteAsync(&key_name(vault_id)).and_then(|op| op.join());
    match entry(vault_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(store_failure(e)),
    }
}

/// The vault's Hello key, made the first time. Opening an existing one does not prompt.
fn open_or_create(vault_id: &str) -> BioResult<KeyCredential> {
    let name = key_name(vault_id);
    let found = KeyCredentialManager::OpenAsync(&name)
        .and_then(|op| op.join())
        .map_err(win_failure)?;
    if found.Status().map_err(win_failure)? == KeyCredentialStatus::Success {
        return found.Credential().map_err(win_failure);
    }
    let op =
        KeyCredentialManager::RequestCreateAsync(&name, KeyCredentialCreationOption::FailIfExists)
            .map_err(win_failure)?;
    surface_prompt();
    let made = op.join().map_err(win_failure)?;
    let status = made.Status().map_err(win_failure)?;
    if status != KeyCredentialStatus::Success {
        return Err(hello_error(status));
    }
    made.Credential().map_err(win_failure)
}

/// Hello's prompt, then its signature over `challenge`.
fn sign(credential: &KeyCredential, challenge: &[u8]) -> BioResult<Zeroizing<Vec<u8>>> {
    let data = CryptographicBuffer::CreateFromByteArray(challenge).map_err(win_failure)?;
    let op = credential.RequestSignAsync(&data).map_err(win_failure)?;
    surface_prompt();
    let result = op.join().map_err(win_failure)?;
    let status = result.Status().map_err(win_failure)?;
    if status != KeyCredentialStatus::Success {
        return Err(hello_error(status));
    }
    let signed = result.Result().map_err(win_failure)?;
    let mut bytes = Array::<u8>::new();
    CryptographicBuffer::CopyToByteArray(&signed, &mut bytes).map_err(win_failure)?;
    Ok(Zeroizing::new(bytes.to_vec()))
}

/// Bring Hello's dialog to the front. Windows opens it without the foreground, minimised and
/// flashing in the taskbar, and this API takes no owner window to fix that. Bramble is the
/// foreground app when it asks (the user just clicked, or opened it), which lets it hand the
/// foreground on, so find the dialog by its window class once it exists and raise it. KeePassXC
/// does the same.
fn surface_prompt() {
    thread::spawn(|| {
        for _ in 0..20 {
            thread::sleep(Duration::from_millis(150));
            let Ok(dialog) =
                (unsafe { FindWindowW(w!("Credential Dialog Xaml Host"), PCWSTR::null()) })
            else {
                continue;
            };
            unsafe {
                if IsIconic(dialog).as_bool() {
                    let _ = ShowWindow(dialog, SW_RESTORE);
                }
                let _ = SetForegroundWindow(dialog);
            }
            return;
        }
    });
}

/// The core's code for a Hello status, by its documented value.
fn hello_error(status: KeyCredentialStatus) -> BioError {
    let code = match status {
        KeyCredentialStatus::UserCanceled | KeyCredentialStatus::UserPrefersPassword => "cancelled",
        KeyCredentialStatus::SecurityDeviceLocked => "lockout",
        KeyCredentialStatus::NotFound => "invalidated",
        _ => "failed",
    };
    BioError::new(code, format!("Windows Hello ({})", status.0))
}
