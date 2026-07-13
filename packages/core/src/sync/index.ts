/** Storage meta key: epoch ms of the last successful reconcile with a peer. Written by the
 * sync host (extension background / mobile in-webview); read by the Sync settings UI. */
export const SYNC_LAST_SYNCED_KEY = "sync.lastSyncedAt";

export * from "./apply-remote";
export * from "./device-clock";
export * from "./enrollment";
export * from "./entries-payload";
export * from "./hlc";
export * from "./merge";
export * from "./nostr";
export * from "./roster";
export * from "./signaling-client";
export * from "./vault-merge";
