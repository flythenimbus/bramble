//! Build-time feature flags, generated from packages/core/src/flags.json by build.rs so TS and Rust
//! share ONE source. Constants are baked in at compile time. See packages/core/src/flags.ts.
#![allow(dead_code)] // generated flags; not every flag is consumed on the Rust side (yet)

include!(concat!(env!("OUT_DIR"), "/flags_generated.rs"));
