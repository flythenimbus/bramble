import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useEffect, useState } from "react";
import type { ExchangeAvailability } from "../adapters/exchange";
import { usePlatform } from "../context/PlatformContext";

/**
 * Whether this device can actually do an OS credential transfer, and why not when it can't.
 *
 * The platform adapter's presence only says the build has the plugin; the answer is per-device
 * (iOS 26+) and per-user (Bramble enabled as a credential provider). Null while the native
 * probe is in flight. See docs/credential-exchange.md.
 */
export function useExchangeAvailability(): ExchangeAvailability | null {
	const { exchange } = usePlatform();
	const [state, setState] = useState<ExchangeAvailability | null>(null);

	useEffect(() => {
		if (!exchange) return;
		let live = true;
		void exchange
			.availability()
			.then((a) => {
				if (live) setState(a);
			})
			// The adapter already swallows native errors into `error`; this is the belt-and-braces
			// case so a rejected probe leaves the UI in a stated condition, not a permanent spinner.
			.catch((err: unknown) => {
				if (live) {
					setState({
						available: false,
						providerEnabled: false,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			});
		return () => {
			live = false;
		};
	}, [exchange]);

	return state;
}

/**
 * One sentence explaining an unavailable transfer, or null when it's good to go. Kept here so
 * the import screen and Settings tell the user the same thing.
 *
 * Uses `msg` + `i18n._` rather than taking a `t` from the caller: `t` is a compile-time macro,
 * so a `t` passed in as an argument would interpolate but never extract or translate, leaving
 * these strings silently English in every locale.
 */
export function exchangeBlockedReason(availability: ExchangeAvailability | null): string | null {
	if (!availability) return null;
	if (availability.error) return i18n._(msg`Couldn't reach the transfer service on this device.`);
	if (!availability.available) {
		const version = availability.osVersion;
		return version
			? i18n._(msg`Transferring between apps needs iOS 26. This device is on iOS ${version}.`)
			: i18n._(msg`Transferring between apps needs iOS 26.`);
	}
	return null;
}
