// uniffi-bindgen CLI entry point. Run in library mode against the compiled cdylib:
//   cargo run --no-default-features --features ffi,uniffi/cli --bin uniffi-bindgen -- \
//     generate --library <path-to-cdylib> --language swift --out-dir bindings/swift
fn main() {
    uniffi::uniffi_bindgen_main()
}
