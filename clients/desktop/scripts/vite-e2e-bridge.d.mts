import type { Plugin } from "vite";

/** Dev-only e2e bridge: a token-gated endpoint on the dev server that drives the vault window. */
export function e2eBridge(): Plugin;
