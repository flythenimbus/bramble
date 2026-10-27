/// <reference types="chrome" />

// Content-script-local copy of the cross-browser API shim. Kept separate from
// ../platform-api on purpose: MV3 content scripts load as classic scripts (not ES
// modules), so the content bundle must stay a single flat file with no chunk
// imports. Sharing ../platform-api with the background entry makes Rollup hoist it
// into a chunk the content script would then try to `import`. See platform-api.ts.
const g = globalThis as typeof globalThis & {
	browser?: typeof chrome;
	chrome?: typeof chrome;
};
export const api: typeof chrome = (g.browser ?? g.chrome) as typeof chrome;
