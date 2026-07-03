/// <reference types="chrome" />

// Cross-browser WebExtension API handle. Firefox exposes the promise-based API as
// `browser`; Chrome exposes `chrome`. Use `globalThis.browser ?? chrome` (never a bare
// `browser`) so vitest under Node does not ReferenceError. Typed as `typeof chrome`:
// the codebase is promise-native and the surfaces used match Chrome's signatures.
const g = globalThis as typeof globalThis & {
	browser?: typeof chrome;
	chrome?: typeof chrome;
};
export const api: typeof chrome = (g.browser ?? g.chrome) as typeof chrome;
