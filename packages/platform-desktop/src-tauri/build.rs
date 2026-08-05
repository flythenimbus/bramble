fn main() {
    // The icon set is embedded by `generate_context!` when the crate compiles, and cargo
    // does not otherwise treat it as an input: regenerating icons then rebuilding is a
    // no-op, and the binary keeps serving the previous artwork with nothing to show it.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
