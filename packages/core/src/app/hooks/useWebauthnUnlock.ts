import { useCan } from "../../context/PlatformContext";
import { webauthnUnlockPossible } from "../../vault/webauthn-ceremony";

/**
 * Whether to offer webauthn unlock at all: the target supports it AND this browser can actually
 * claim an rpID to register against.
 *
 * The capability alone is not enough. It is static per target, while the second half is a runtime
 * property of the browser build: Firefox only gained the ability to claim an rpID from
 * `host_permissions` in 150, and the manifest supports 128+. Offering the button to those users
 * would fail every time with "The operation is insecure". See webauthnUnlockPossible().
 *
 * Not reactive, and does not need to be: the shell installs the rpID at import, long before React
 * mounts, and it cannot change while the page lives.
 */
export function useWebauthnUnlock(): boolean {
	return useCan("webauthnUnlock") && webauthnUnlockPossible();
}
