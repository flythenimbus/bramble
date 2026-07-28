// Keys in chrome.storage.session shared between the UI (popup/options) and the background.
// Dependency-free so the UI can import them without pulling in any background code.

/**
 * The id of the currently active/unlocked vault, so the background can sync THAT vault instead
 * of the primary. Written by the UI on unlock (`shell.setActiveVault`) and cleared on lock
 * (`clearSession`). It is a UUID, not a secret. See docs/multiple-vaults.md (Sync).
 */
export const ACTIVE_VAULT_SESSION_KEY = "vault.activeId";

/**
 * A corner-prompt capture parked while the vault was locked ("Unlock & Save"), committed by the
 * background once a view unlocks. Holds a plaintext password, so it lives in session only and is
 * dropped on lock. Shared here because more than one background concern has to see it.
 */
export const CORNER_HANDOFF_KEY = "cornerPrompt.handoff";
