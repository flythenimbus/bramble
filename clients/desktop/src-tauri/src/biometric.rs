//! Touch ID / Windows Hello unlock: each vault's VEK cached on this device behind an OS gate.
//!
//! The key never enters the webview. Arming reads it from the crypto session and unlocking
//! installs it there, so these commands carry a vault id and a verdict, nothing else. The core
//! drives them through `BiometricUnlock` with `holdsKeyNatively`. One implementation per OS sits
//! behind the same five functions; see docs/desktop-biometric-unlock.md.

use serde::Serialize;
use zeroize::Zeroizing;

#[cfg(target_os = "macos")]
#[path = "biometric_macos.rs"]
mod os;

#[cfg(windows)]
#[path = "biometric_windows.rs"]
mod os;

/// Linux has no hardware-backed equivalent: fprintd behind polkit is a yes/no answer, not
/// something that protects the key.
#[cfg(not(any(target_os = "macos", windows)))]
mod os {
    use super::{BioError, BioResult, Status};

    pub fn status() -> Status {
        Status::default()
    }
    pub fn has(_vault_id: &str) -> bool {
        false
    }
    pub fn arm(_vault_id: &str, _allow_passcode: bool) -> BioResult<()> {
        Err(BioError::unavailable())
    }
    pub fn unlock(_vault_id: &str, _allow_passcode: bool) -> BioResult<()> {
        Err(BioError::unavailable())
    }
    pub fn delete(_vault_id: &str) -> BioResult<()> {
        Ok(())
    }
}

/// What the webview needs to decide whether to offer the gate and what to call it.
#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub available: bool,
    /// `touchId` or `windowsHello`; empty where nothing is available.
    pub biometry_type: &'static str,
    pub biometry_enrolled: bool,
}

/// Rejected to JS as an object, so `code` reaches the core's `isBiometricCancel` and friends:
/// `cancelled`, `interrupted`, `invalidated` and `lockout` are the ones it acts on.
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct BioError {
    pub code: &'static str,
    pub message: String,
}

impl BioError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// Only the Linux stub answers this way; the others report unavailability through `status`.
    #[cfg_attr(any(target_os = "macos", windows), allow(dead_code))]
    pub fn unavailable() -> Self {
        Self::new(
            "unavailable",
            "Biometric unlock isn't available on this device",
        )
    }
}

pub type BioResult<T> = Result<T, BioError>;

/// A local vault id is uuid-shaped. It names the keychain item, so nothing else gets that far.
fn checked(vault_id: &str) -> BioResult<&str> {
    let ok = !vault_id.is_empty()
        && vault_id.len() <= 64
        && vault_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if ok {
        Ok(vault_id)
    } else {
        Err(BioError::new("failed", "Not a vault id"))
    }
}

#[tauri::command(async)]
pub fn biometric_status() -> Status {
    os::status()
}

#[tauri::command(async)]
pub fn biometric_is_enabled(vault_id: String) -> bool {
    checked(&vault_id).map(os::has).unwrap_or(false)
}

/// Cache the open vault's VEK behind the gate. `allow_passcode` picks the gate on macOS (Touch ID
/// alone, or Touch ID or the login password) and is fixed until the next `enable`; Windows Hello
/// always takes its PIN and ignores it.
#[tauri::command(async)]
pub fn biometric_enable(vault_id: String, allow_passcode: bool) -> BioResult<()> {
    os::arm(checked(&vault_id)?, allow_passcode)
}

/// Prompt, then install the cached VEK in the crypto session. Whether that key still opens the
/// vault is the caller's next step (loading entries), as it is on mobile.
#[tauri::command(async)]
pub fn biometric_unlock(vault_id: String, allow_passcode: bool) -> BioResult<()> {
    os::unlock(checked(&vault_id)?, allow_passcode)
}

/// The open vault's VEK, for a gate that stores it whole (macOS).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn session_vek() -> BioResult<Zeroizing<String>> {
    vault_crypto::export_vek()
        .map(Zeroizing::new)
        .map_err(|e| BioError::new("failed", e.to_string()))
}

/// Load a VEK a gate released into the crypto session (macOS).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn install_vek(mut vek: Zeroizing<String>) -> BioResult<()> {
    vault_crypto::unlock_with_vek(std::mem::take(&mut *vek))
        .map_err(|e| BioError::new("failed", e.to_string()))
}

#[tauri::command(async)]
pub fn biometric_disable(vault_id: String) -> BioResult<()> {
    os::delete(checked(&vault_id)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_a_local_vault_id_and_nothing_else() {
        assert!(checked("0f8c2a6e-5b1d-4c7e-9a3f-2d6b8e1c4a90").is_ok());
        assert!(checked("vault_1").is_ok());
        for bad in ["", "a/b", "../x", "vek:1", "a b", &"x".repeat(65)] {
            assert_eq!(checked(bad).unwrap_err().code, "failed", "{bad:?}");
        }
    }

    #[test]
    fn errors_reach_js_with_the_code_the_core_reads() {
        let json = serde_json::to_value(BioError::new("cancelled", "dismissed")).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "code": "cancelled", "message": "dismissed" })
        );
    }

    #[test]
    fn status_serializes_camel_case() {
        let json = serde_json::to_value(Status {
            available: true,
            biometry_type: "touchId",
            biometry_enrolled: true,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "available": true, "biometryType": "touchId", "biometryEnrolled": true })
        );
    }
}
