//! macOS: the VEK in a data protection keychain item whose access control asks for Touch ID, or
//! with passcode fallback Touch ID or the login password. The iOS design
//! (clients/mobile/ios/App/App/BiometricVault.swift) on the same Security framework.
//!
//! Needs the signed app: the data protection keychain refuses a build without the
//! `keychain-access-groups` entitlement and its embedded provisioning profile, and `status` reports
//! that as unavailable so the webview never offers a toggle that can only fail.

use std::sync::mpsc;

use block2::RcBlock;
use core_foundation::base::{CFType, CFTypeRef, TCFType};
use objc2::{
    class, msg_send,
    rc::{autoreleasepool, Retained},
    runtime::{AnyObject, Bool},
};
use objc2_foundation::NSString;
use security_framework::{
    access_control::{ProtectionMode, SecAccessControl},
    base::Error as SecError,
    item::{ItemClass, ItemSearchOptions, Limit, SearchResult},
    passwords::{delete_generic_password_options, set_generic_password_options},
    passwords_options::{AccessControlOptions, PasswordOptions},
};
use zeroize::Zeroizing;

use super::{install_vek, session_vek, BioError, BioResult, Status};

#[link(name = "LocalAuthentication", kind = "framework")]
extern "C" {}

const SERVICE: &str = "app.bramble.desktop.biometric";
/// The app's own group, as the provisioning profile grants it: team prefix, then bundle id.
const ACCESS_GROUP: &str = "BHGR3PP64J.app.bramble.desktop";

// LAPolicy
const POLICY_BIOMETRICS: isize = 1;
const POLICY_OWNER: isize = 2;
// LABiometryType
const BIOMETRY_TOUCH_ID: isize = 1;

// OSStatus
const ERR_USER_CANCELED: i32 = -128;
const ERR_AUTH_FAILED: i32 = -25293;
const ERR_ITEM_NOT_FOUND: i32 = -25300;
const ERR_INTERACTION_NOT_ALLOWED: i32 = -25308;
const ERR_MISSING_ENTITLEMENT: i32 = -34018;

fn account(vault_id: &str) -> String {
    format!("vek:{vault_id}")
}

fn search(vault_id: &str) -> ItemSearchOptions {
    let mut q = ItemSearchOptions::new();
    q.class(ItemClass::generic_password())
        .service(SERVICE)
        .account(&account(vault_id))
        .access_group(ACCESS_GROUP)
        .ignore_legacy_keychains()
        .limit(Limit::Max(1));
    q
}

fn sec_failure(e: SecError) -> BioError {
    BioError::new("failed", format!("Keychain error {}", e.code()))
}

pub fn status() -> Status {
    autoreleasepool(|_| {
        if !entitled() {
            return Status::default();
        }
        let ctx = la_context();
        let enrolled = can_evaluate(&ctx, POLICY_BIOMETRICS).is_ok();
        // Only meaningful after a canEvaluatePolicy call, which is why it is read second.
        let kind: isize = unsafe { msg_send![&*ctx, biometryType] };
        // Touch ID only: on a Mac without it the gate would be the login password alone, mostly
        // a weaker master password. See docs/desktop-biometric-unlock.md.
        Status {
            available: enrolled && kind == BIOMETRY_TOUCH_ID,
            biometry_type: "touchId",
            biometry_enrolled: enrolled,
        }
    })
}

/// Whether this build may use the data protection keychain at all. A lookup of an item that never
/// exists answers "not found" for the signed app and "missing entitlement" for anything else.
fn entitled() -> bool {
    match search("probe").load_attributes(true).search() {
        Ok(_) => true,
        Err(e) => e.code() != ERR_MISSING_ENTITLEMENT,
    }
}

/// Whether the item exists, without ever prompting. Even an attribute read can make macOS ask
/// (its generic "needs to authenticate to continue" sheet, seen at launch before the real
/// unlock), so the read carries a context that may not show UI, and "would have needed you"
/// counts as present, as iOS's check does.
pub fn has(vault_id: &str) -> bool {
    autoreleasepool(|_| {
        let ctx = la_context();
        unsafe {
            let _: () = msg_send![&*ctx, setInteractionNotAllowed: Bool::YES];
        }
        let ctx_cf = unsafe { CFType::wrap_under_get_rule(Retained::as_ptr(&ctx) as CFTypeRef) };
        match search(vault_id)
            .local_authentication_context(Some(ctx_cf))
            .load_attributes(true)
            .search()
        {
            Ok(found) => !found.is_empty(),
            Err(e) => e.code() == ERR_INTERACTION_NOT_ALLOWED,
        }
    })
}

pub fn arm(vault_id: &str, allow_passcode: bool) -> BioResult<()> {
    store(vault_id, session_vek()?.as_bytes(), allow_passcode)
}

pub fn unlock(vault_id: &str, allow_passcode: bool) -> BioResult<()> {
    install_vek(load(vault_id, allow_passcode)?)
}

fn store(vault_id: &str, secret: &[u8], allow_passcode: bool) -> BioResult<()> {
    // The gate is fixed at write time, so re-arming replaces the item rather than updating it.
    delete(vault_id)?;
    let gate = if allow_passcode {
        AccessControlOptions::USER_PRESENCE
    } else {
        // Touch ID alone, and macOS discards the item when the enrolled fingers change.
        AccessControlOptions::BIOMETRY_CURRENT_SET
    };
    let access = SecAccessControl::create_with_protection(
        Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
        gate.bits(),
    )
    .map_err(sec_failure)?;
    let mut opts = PasswordOptions::new_generic_password(SERVICE, &account(vault_id));
    opts.use_protected_keychain();
    opts.set_access_group(ACCESS_GROUP);
    opts.set_access_control(access);
    opts.set_label("Bramble vault key");
    set_generic_password_options(secret, opts).map_err(sec_failure)
}

fn load(vault_id: &str, allow_passcode: bool) -> BioResult<Zeroizing<String>> {
    autoreleasepool(|_| {
        // Authenticate first, as iOS does, so a cancel and a lockout are told apart, then read
        // the item with that context rather than letting the keychain prompt a second time.
        let ctx = la_context();
        let policy = if allow_passcode {
            POLICY_OWNER
        } else {
            POLICY_BIOMETRICS
        };
        evaluate(&ctx, policy, &crate::i18n::t("biometric.reason")).map_err(|code| {
            BioError::new(la_code(code), format!("Authentication failed ({code})"))
        })?;
        let ctx_cf = unsafe { CFType::wrap_under_get_rule(Retained::as_ptr(&ctx) as CFTypeRef) };
        let found = search(vault_id)
            .local_authentication_context(Some(ctx_cf))
            .load_data(true)
            .search();
        match found {
            Ok(results) => match results.into_iter().next() {
                Some(SearchResult::Data(bytes)) => {
                    let bytes = Zeroizing::new(bytes);
                    let vek = std::str::from_utf8(&bytes)
                        .map_err(|_| BioError::new("failed", "The stored key is unreadable"))?;
                    Ok(Zeroizing::new(vek.to_owned()))
                }
                _ => Err(BioError::new("no-secret", "No key stored for this vault")),
            },
            Err(e) if e.code() == ERR_ITEM_NOT_FOUND => {
                Err(BioError::new("no-secret", "No key stored for this vault"))
            }
            // Authenticated, yet the item won't open: a Touch ID-only item killed by a change to
            // the enrolled fingers. It can never open again, so it goes.
            Err(e) if e.code() == ERR_AUTH_FAILED => {
                let _ = delete(vault_id);
                Err(BioError::new(
                    "invalidated",
                    "Touch ID changed; the cached key was discarded",
                ))
            }
            Err(e) if e.code() == ERR_USER_CANCELED => Err(BioError::new("cancelled", "Cancelled")),
            Err(e) => Err(sec_failure(e)),
        }
    })
}

pub fn delete(vault_id: &str) -> BioResult<()> {
    let mut opts = PasswordOptions::new_generic_password(SERVICE, &account(vault_id));
    opts.use_protected_keychain();
    opts.set_access_group(ACCESS_GROUP);
    match delete_generic_password_options(opts) {
        Err(e) if e.code() != ERR_ITEM_NOT_FOUND => Err(sec_failure(e)),
        _ => Ok(()),
    }
}

/// The core's code for an LAError, by its documented value.
fn la_code(code: isize) -> &'static str {
    match code {
        // userCancel, appCancel, and userFallback: "Enter Password" on a Touch ID-only prompt,
        // which offers nothing to enter here.
        -2 | -9 | -3 => "cancelled",
        // systemCancel (another app took focus), notInteractive.
        -4 | -1004 => "interrupted",
        -8 => "lockout",
        // passcodeNotSet, biometryNotAvailable, biometryNotEnrolled.
        -5 | -6 | -7 => "unavailable",
        _ => "failed",
    }
}

fn la_context() -> Retained<AnyObject> {
    unsafe { msg_send![class!(LAContext), new] }
}

fn can_evaluate(ctx: &AnyObject, policy: isize) -> Result<(), isize> {
    let mut error: *mut AnyObject = std::ptr::null_mut();
    let ok: Bool = unsafe { msg_send![ctx, canEvaluatePolicy: policy, error: &mut error] };
    if ok.as_bool() {
        Ok(())
    } else {
        Err(error_code(error))
    }
}

/// Runs the prompt and waits for its answer. Commands run off the main thread, and the reply
/// arrives on a private queue, so blocking here holds up nothing else.
fn evaluate(ctx: &AnyObject, policy: isize, reason: &str) -> Result<(), isize> {
    let (tx, rx) = mpsc::channel();
    let reply = RcBlock::new(move |ok: Bool, error: *mut AnyObject| {
        let _ = tx.send(if ok.as_bool() {
            Ok(())
        } else {
            Err(error_code(error))
        });
    });
    let reason = NSString::from_str(reason);
    unsafe {
        let _: () =
            msg_send![ctx, evaluatePolicy: policy, localizedReason: &*reason, reply: &*reply];
    }
    rx.recv().unwrap_or(Err(0))
}

fn error_code(error: *mut AnyObject) -> isize {
    if error.is_null() {
        0
    } else {
        unsafe { msg_send![error, code] }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The Objective-C side for real, short of the prompt: wrong selector or argument types fail
    // here rather than on a user's Mac.
    #[test]
    fn asks_local_authentication_what_the_mac_has_without_prompting() {
        autoreleasepool(|_| {
            let ctx = la_context();
            let _ = can_evaluate(&ctx, POLICY_BIOMETRICS);
            let kind: isize = unsafe { msg_send![&*ctx, biometryType] };
            assert!((0..=4).contains(&kind), "{kind}");
        });
    }

    // The test binary carries no keychain-access-groups entitlement, like a dev build.
    #[test]
    fn an_unsigned_build_reports_the_gate_unavailable() {
        assert!(!entitled());
        assert!(!status().available);
        assert!(!has("0f8c2a6e-5b1d-4c7e-9a3f-2d6b8e1c4a90"));
    }

    #[test]
    fn maps_each_la_error_to_the_code_the_core_reads() {
        assert_eq!(la_code(-2), "cancelled");
        assert_eq!(la_code(-3), "cancelled");
        assert_eq!(la_code(-9), "cancelled");
        assert_eq!(la_code(-4), "interrupted");
        assert_eq!(la_code(-8), "lockout");
        assert_eq!(la_code(-7), "unavailable");
        assert_eq!(la_code(-1), "failed");
    }
}
