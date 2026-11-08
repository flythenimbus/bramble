//! Locks the vault after the "Auto-lock timeout" of inactivity. The clock runs in this process,
//! not the webview, whose timers are throttled while the window is hidden (see `backup`).

use std::{
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::{index_store, storage, storage::ops};

pub const LOCKED_EVENT: &str = "vault://auto-locked";
const CHECK_SECONDS: u64 = 15;
const PREF: &str = "pref.autoLockMinutes";
const DEFAULT_MINUTES: i64 = 15;
/// Where a stored "Immediate" (-1) lands: desktop does not offer it.
const SHORTEST_MINUTES: i64 = 5;

/// The timeout in minutes, 0 meaning never.
fn timeout_minutes(stored: Option<&Value>) -> i64 {
    match stored.and_then(Value::as_i64) {
        Some(m) if m < 0 => SHORTEST_MINUTES,
        Some(m) => m,
        None => DEFAULT_MINUTES,
    }
}

#[derive(Debug, PartialEq)]
enum Step {
    Nothing,
    /// The vault was just unlocked, which starts the clock.
    Restart,
    Lock,
}

/// One check. `was_locked` is what the previous check saw.
fn step(was_locked: bool, locked: bool, minutes: i64, idle: Duration) -> Step {
    if locked {
        Step::Nothing
    } else if was_locked {
        Step::Restart
    } else if minutes > 0 && idle >= Duration::from_secs(minutes as u64 * 60) {
        Step::Lock
    } else {
        Step::Nothing
    }
}

/// Time since `last`, both in ms since the epoch. A clock set back reads as no idle time.
fn idle(last_ms: u64, now_ms: u64) -> Duration {
    Duration::from_millis(now_ms.saturating_sub(last_ms))
}

/// Rewrite a stored "Immediate" so the setting shows a timeout desktop actually offers.
fn migrate(root: &Path) {
    if let Ok(Some(stored)) = ops::get_meta(root, PREF) {
        if stored.as_i64().is_some_and(|m| m < 0) {
            if let Err(e) = ops::set_meta(root, PREF.into(), SHORTEST_MINUTES.into()) {
                log::warn!("auto-lock: could not rewrite Immediate: {e}");
            }
        }
    }
}

/// Wall-clock ms, not `Instant`: an `Instant` stops while the machine sleeps, and time asleep
/// has to count as inactivity.
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

static LAST_ACTIVITY_MS: AtomicU64 = AtomicU64::new(0);

/// Record user activity: input in either window, or a fill the browser link served.
pub fn touch() {
    LAST_ACTIVITY_MS.store(now_ms(), Ordering::Relaxed);
}

pub(crate) fn last_activity_ms() -> u64 {
    LAST_ACTIVITY_MS.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn autolock_touch() {
    touch();
}

fn lock_now(app: &AppHandle) {
    vault_crypto::lock();
    index_store::clear();
    if let Err(e) = app.emit(LOCKED_EVENT, ()) {
        log::warn!("auto-lock event not delivered: {e}");
    }
    log::info!("auto-locked after inactivity");
}

pub fn start(app: AppHandle) {
    let root = storage::data_dir(&app).ok();
    if let Some(root) = &root {
        migrate(root);
    }
    touch();
    std::thread::spawn(move || {
        let mut was_locked = vault_crypto::is_locked();
        loop {
            std::thread::sleep(Duration::from_secs(CHECK_SECONDS));
            let stored = root
                .as_deref()
                .and_then(|r| ops::get_meta(r, PREF).ok().flatten());
            let minutes = timeout_minutes(stored.as_ref());
            let idle = idle(last_activity_ms(), now_ms());
            match step(was_locked, vault_crypto::is_locked(), minutes, idle) {
                Step::Restart => touch(),
                Step::Lock => lock_now(&app),
                Step::Nothing => {}
            }
            was_locked = vault_crypto::is_locked();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_timeout_defaults_to_15_minutes() {
        assert_eq!(timeout_minutes(None), 15);
        assert_eq!(timeout_minutes(Some(&json!("5"))), 15);
    }

    #[test]
    fn the_timeout_is_the_stored_minutes() {
        assert_eq!(timeout_minutes(Some(&json!(30))), 30);
        assert_eq!(timeout_minutes(Some(&json!(0))), 0);
    }

    #[test]
    fn a_stored_immediate_counts_as_the_shortest_timeout() {
        assert_eq!(timeout_minutes(Some(&json!(-1))), 5);
    }

    #[test]
    fn locks_once_the_timeout_has_passed() {
        let five = Duration::from_secs(5 * 60);
        assert_eq!(
            step(false, false, 5, five - Duration::from_secs(1)),
            Step::Nothing
        );
        assert_eq!(step(false, false, 5, five), Step::Lock);
    }

    #[test]
    fn never_locks_under_never() {
        assert_eq!(
            step(false, false, 0, Duration::from_secs(86_400)),
            Step::Nothing
        );
    }

    #[test]
    fn an_unlock_restarts_the_clock_instead_of_locking() {
        assert_eq!(
            step(true, false, 5, Duration::from_secs(86_400)),
            Step::Restart
        );
    }

    #[test]
    fn a_locked_vault_is_left_alone() {
        assert_eq!(
            step(false, true, 5, Duration::from_secs(86_400)),
            Step::Nothing
        );
        assert_eq!(
            step(true, true, 5, Duration::from_secs(86_400)),
            Step::Nothing
        );
    }

    #[test]
    fn idle_time_is_wall_clock_and_never_negative() {
        assert_eq!(idle(1_000, 61_000), Duration::from_secs(60));
        assert_eq!(idle(61_000, 1_000), Duration::ZERO);
    }

    #[test]
    fn migrate_rewrites_a_stored_immediate_only() {
        let dir = tempfile::tempdir().unwrap();
        ops::set_meta(dir.path(), PREF.into(), json!(-1)).unwrap();
        migrate(dir.path());
        assert_eq!(ops::get_meta(dir.path(), PREF).unwrap(), Some(json!(5)));

        ops::set_meta(dir.path(), PREF.into(), json!(30)).unwrap();
        migrate(dir.path());
        assert_eq!(ops::get_meta(dir.path(), PREF).unwrap(), Some(json!(30)));

        let empty = tempfile::tempdir().unwrap();
        migrate(empty.path());
        assert_eq!(ops::get_meta(empty.path(), PREF).unwrap(), None);
    }
}
