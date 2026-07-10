// Generate Rust constants from the single source of truth (packages/core/src/flags.json), so TS
// (packages/core/src/flags.ts) and Rust never drift. Runs on the host at build time; the constants
// are baked in - no runtime JSON parsing, no runtime serde_json in the shipped binary.

use std::{env, fs, path::Path};

fn main() {
    let flags_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../core/src/flags.json");
    let json = fs::read_to_string(&flags_path)
        .unwrap_or_else(|e| panic!("read {}: {e}", flags_path.display()));
    let flags: serde_json::Value = serde_json::from_str(&json).expect("parse flags.json");
    let obj = flags.as_object().expect("flags.json must be a JSON object");

    let mut out = String::from("// @generated from packages/core/src/flags.json by build.rs\n");
    for (key, val) in obj {
        let b = val
            .as_bool()
            .unwrap_or_else(|| panic!("flag `{key}` must be a boolean"));
        out.push_str(&format!("pub const {}: bool = {b};\n", screaming_snake(key)));
    }

    let dest = Path::new(&env::var("OUT_DIR").unwrap()).join("flags_generated.rs");
    fs::write(&dest, out).expect("write flags_generated.rs");
    println!("cargo:rerun-if-changed={}", flags_path.display());
}

/// `rosterRequireSignatures` -> `ROSTER_REQUIRE_SIGNATURES`.
fn screaming_snake(camel: &str) -> String {
    let mut s = String::new();
    for c in camel.chars() {
        if c.is_ascii_uppercase() {
            s.push('_');
        }
        s.push(c.to_ascii_uppercase());
    }
    s
}
