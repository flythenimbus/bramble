//! Translations for the chrome this process draws itself: the tray menu, and the macOS menu bar.
//!
//! Deliberately its own layer rather than a reach into the app's Lingui catalogs. Those live in
//! the webview and resolve after it boots, and this chrome exists before any webview does, outlives
//! every webview on Wayland (a close destroys the window, see `lifetime`), and is the *only* UI at
//! all when the app autostarts hidden. A label pushed over IPC would therefore be English until
//! something opened, and then visibly flip. Resolving here happens once, at startup, from the OS
//! locale, and never changes again.
//!
//! Catalogs are flat JSON, one per locale, embedded with `include_str!` so a build is self
//! contained and a lookup cannot touch the disk. English is the source; the rest are translated by
//! `scripts/i18n/tauri-menus.mjs` alongside every other native surface (Android XML, the iOS string
//! catalog, the extension's `_locales`) and gated by `scripts/i18n-check.mjs`. `{app}` and
//! `{author}` are the only placeholders, so word order stays the translator's to choose: German
//! wants "Bramble beenden" where Spanish wants "Salir de Bramble".

use std::collections::HashMap;
use std::sync::OnceLock;

type Catalog = HashMap<String, String>;

pub const APP_NAME: &str = "Bramble";
pub const AUTHOR: &str = "flythenimbus";

const EN: &str = include_str!("../locales/en.json");

/// Every locale we ship, keyed by the same codes as `packages/core/src/i18n.ts`.
const CATALOGS: &[(&str, &str)] = &[
    ("de", include_str!("../locales/de.json")),
    ("es", include_str!("../locales/es.json")),
    ("fr", include_str!("../locales/fr.json")),
    ("it", include_str!("../locales/it.json")),
    ("pt-BR", include_str!("../locales/pt-BR.json")),
];

/// A translated string, with `{app}` and `{author}` filled in.
///
/// Falls back key by key rather than catalog by catalog: a locale missing one string still gets
/// its own for everything else. A key in no catalog at all returns itself, which is wrong on
/// screen but never blank and never a panic.
pub fn t(key: &str) -> String {
    fill(lookup(active(), english(), key))
}

/// The active locale's string, else English's, else the key itself.
fn lookup<'a>(active: &'a Catalog, en: &'a Catalog, key: &'a str) -> &'a str {
    if let Some(hit) = active.get(key).or_else(|| en.get(key)) {
        return hit;
    }
    log::warn!("no translation for {key}, not even in English");
    key
}

/// Substitute the two placeholders. Not a format library: these are menu labels, and the day one
/// needs a number or a plural is the day this is the wrong shape.
fn fill(raw: &str) -> String {
    raw.replace("{app}", APP_NAME).replace("{author}", AUTHOR)
}

fn english() -> &'static Catalog {
    static EN_MAP: OnceLock<Catalog> = OnceLock::new();
    // Panics on malformed English rather than degrading: it is committed to this repo, embedded at
    // compile time, and covered by the tests below, so a failure here is a broken build.
    EN_MAP.get_or_init(|| serde_json::from_str(EN).expect("locales/en.json must parse"))
}

fn active() -> &'static Catalog {
    static ACTIVE: OnceLock<Catalog> = OnceLock::new();
    ACTIVE.get_or_init(|| {
        let tag = sys_locale::get_locale();
        let Some(code) = resolve(tag.as_deref()) else {
            return Catalog::new();
        };
        let Some((_, raw)) = CATALOGS.iter().find(|(c, _)| *c == code) else {
            return Catalog::new();
        };
        match serde_json::from_str(raw) {
            Ok(map) => {
                log::info!("native strings: {code} (from {})", tag.unwrap_or_default());
                map
            }
            // English is already the per-key fallback, so a broken catalog costs the language and
            // nothing else.
            Err(e) => {
                log::warn!("locales/{code}.json did not parse, using English: {e}");
                Catalog::new()
            }
        }
    })
}

/// Pick a shipped catalog for a system locale tag, or `None` for English.
///
/// Exact match first, then the base language, which is the same rule `resolveLocale` applies in
/// `packages/core/src/i18n.ts` so the menu bar and the window it belongs to cannot disagree.
/// Tolerates POSIX spellings (`pt_BR.UTF-8`, `de_DE@euro`) because `LANG` is where this comes from
/// on Linux, whatever `sys-locale` normalises elsewhere.
fn resolve(tag: Option<&str>) -> Option<&'static str> {
    let tag = tag?
        .split(['.', '@'])
        .next()?
        .replace('_', "-")
        .to_lowercase();
    if tag.is_empty() {
        return None;
    }
    if let Some((code, _)) = CATALOGS.iter().find(|(c, _)| c.to_lowercase() == tag) {
        return Some(code);
    }
    let base = tag.split('-').next()?;
    CATALOGS
        .iter()
        .find(|(c, _)| c.split('-').next().unwrap_or(c).to_lowercase() == base)
        .map(|(code, _)| *code)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(raw: &str) -> Catalog {
        serde_json::from_str(raw).expect("catalog must parse")
    }

    /// The gate that makes this layer stable: a shipped catalog that is missing a key falls back to
    /// English *silently*, which is the failure mode nobody notices. i18n-check.mjs says the same
    /// thing for the release, and this says it on every `cargo test`.
    #[test]
    fn every_catalog_matches_english_key_for_key() {
        let en = parse(EN);
        for (code, raw) in CATALOGS {
            let map = parse(raw);
            let missing: Vec<_> = en.keys().filter(|k| !map.contains_key(*k)).collect();
            let extra: Vec<_> = map.keys().filter(|k| !en.contains_key(*k)).collect();
            assert!(missing.is_empty(), "{code} is missing {missing:?}");
            assert!(
                extra.is_empty(),
                "{code} has keys English does not: {extra:?}"
            );
        }
    }

    /// A dropped `{app}` is the other silent failure: the string still renders, just without the
    /// name of the application in it ("beenden" on its own).
    #[test]
    fn translations_keep_every_placeholder() {
        let en = parse(EN);
        for (code, raw) in CATALOGS {
            for (key, translated) in parse(raw) {
                let source = en.get(&key).expect("checked by the test above");
                for placeholder in ["{app}", "{author}"] {
                    assert_eq!(
                        source.contains(placeholder),
                        translated.contains(placeholder),
                        "{code}/{key} disagrees with English about {placeholder}"
                    );
                }
            }
        }
    }

    #[test]
    fn resolves_exact_then_base_language() {
        assert_eq!(resolve(Some("de")), Some("de"));
        assert_eq!(resolve(Some("pt-BR")), Some("pt-BR"));
        // Regional variants we do not ship fall to the language we do.
        assert_eq!(resolve(Some("de-AT")), Some("de"));
        assert_eq!(resolve(Some("es-419")), Some("es"));
        assert_eq!(resolve(Some("pt")), Some("pt-BR"));
    }

    #[test]
    fn resolves_posix_spellings() {
        assert_eq!(resolve(Some("pt_BR.UTF-8")), Some("pt-BR"));
        assert_eq!(resolve(Some("de_DE@euro")), Some("de"));
        assert_eq!(resolve(Some("FR_fr")), Some("fr"));
    }

    #[test]
    fn falls_back_to_english() {
        // None means "no catalog", which is English: it is the source, not a translation.
        assert_eq!(resolve(Some("en-GB")), None);
        assert_eq!(resolve(Some("ja")), None);
        assert_eq!(resolve(Some("")), None);
        assert_eq!(resolve(Some("C")), None);
        assert_eq!(resolve(None), None);
    }

    #[test]
    fn fills_placeholders() {
        assert_eq!(fill("Open {app}"), "Open Bramble");
        assert_eq!(fill("By {author}"), "By flythenimbus");
        assert_eq!(fill("Quick Access"), "Quick Access");
    }

    /// Per key, not per catalog: a locale that is missing one string keeps its own for the rest.
    #[test]
    fn lookup_falls_back_key_by_key() {
        let en = parse(EN);
        let mut active = Catalog::new();
        active.insert("tray.quick".into(), "Schnellzugriff".into());
        assert_eq!(lookup(&active, &en, "tray.quick"), "Schnellzugriff");
        assert_eq!(lookup(&active, &en, "tray.open"), "Open {app}");
        assert_eq!(lookup(&active, &en, "no.such.key"), "no.such.key");
    }

    /// Locale-independent, so it holds whatever LANG the test machine has: every catalog spells
    /// the app name with the placeholder, so a filled string always contains it.
    #[test]
    fn t_reads_the_active_catalog() {
        assert!(t("tray.open").contains(APP_NAME));
        assert!(!t("tray.open").contains("{app}"));
    }
}
