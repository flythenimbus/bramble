// atob/btoa rather than Buffer, so the core runs on Workers unchanged.

export const fromBase64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
