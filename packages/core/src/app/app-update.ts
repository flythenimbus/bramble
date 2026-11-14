// Telling a mobile install that a newer version exists. See docs/mobile-update-notice.md.
//
// The desktop updates itself (shell.updates); the apps cannot, so they only point at where the
// update is: the App Store listing on iOS, the signed APK on GitHub on Android.

import type { Target } from "../flags";
import { REPO_URL } from "./repo";

const HOUR_MS = 3_600_000;

/** At most one request a day, however often the app is opened. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * HOUR_MS;

/** A slow network must not leave a request hanging for the life of the session. */
const FETCH_TIMEOUT_MS = 10_000;

/** Per target. Presence here IS the capability, as with STORE_REVIEW_URL. */
export const UPDATE_MANIFEST_URL: Partial<Record<Target, string>> = {
	ios: "https://bramble.sh/ios/latest.json",
	android: "https://bramble.sh/android/latest.json",
};

/** Opens the App Store app rather than a web page. */
export const APP_STORE_URL = "https://apps.apple.com/app/id6783071787";

/** Only an APK from our own releases is ever offered, whatever the manifest says. */
const APK_PREFIX = `${REPO_URL}/releases/download/`;

export interface AvailableUpdate {
	version: string;
	/** Where "Update now" goes. */
	url: string;
}

export interface AppUpdateState {
	/** Last successful check. */
	checkedAt?: number;
	/** What that check found, kept so the card survives a restart without a second request. */
	latest?: AvailableUpdate;
	/** The version the card was closed for. A newer one shows it again. */
	dismissed?: string;
}

const VERSION = /^\d+(\.\d+){0,2}$/;

/** "1.24.0 (1234)" -> "1.24.0". Null for the dev placeholder, which would always look outdated. */
export function installedVersion(shellVersion: string): string | null {
	const v = shellVersion.match(/^\d+(\.\d+){0,2}/)?.[0];
	return v && !/^0(\.0)*$/.test(v) ? v : null;
}

/** Numeric, segment by segment; a missing segment is 0. */
export function isNewer(candidate: string, current: string): boolean {
	const a = candidate.split(".").map(Number);
	const b = current.split(".").map(Number);
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const d = (a[i] ?? 0) - (b[i] ?? 0);
		if (d !== 0) return d > 0;
	}
	return false;
}

/** A `checkedAt` in the future (the clock was wrong) is due, or it would never check again. */
export function isCheckDue(state: AppUpdateState, now: number): boolean {
	if (state.checkedAt === undefined || state.checkedAt > now) return true;
	return now - state.checkedAt >= UPDATE_CHECK_INTERVAL_MS;
}

/** Field by field, like normalizeReviewNudgeState: stored values may come from another build. */
export function normalizeAppUpdateState(raw: unknown): AppUpdateState {
	if (!raw || typeof raw !== "object") return {};
	const r = raw as Record<string, unknown>;
	const latest = r.latest as Record<string, unknown> | undefined;
	return {
		checkedAt: typeof r.checkedAt === "number" ? r.checkedAt : undefined,
		latest:
			latest && typeof latest.version === "string" && typeof latest.url === "string"
				? { version: latest.version, url: latest.url }
				: undefined,
		dismissed: typeof r.dismissed === "string" ? r.dismissed : undefined,
	};
}

/** The update to offer, or null. */
export function pendingUpdate(state: AppUpdateState, current: string): AvailableUpdate | null {
	const latest = state.latest;
	if (!latest || latest.version === state.dismissed) return null;
	return isNewer(latest.version, current) ? latest : null;
}

/** Read a manifest from the endpoint. Throws on anything unusable, so the caller retries later. */
export function parseManifest(target: Target, raw: unknown): AvailableUpdate {
	const m = (raw ?? {}) as Record<string, unknown>;
	if (typeof m.version !== "string" || !VERSION.test(m.version))
		throw new Error("manifest: bad version");
	if (target === "ios") return { version: m.version, url: APP_STORE_URL };
	if (typeof m.url !== "string" || !m.url.startsWith(APK_PREFIX) || !m.url.endsWith(".apk"))
		throw new Error("manifest: bad url");
	return { version: m.version, url: m.url };
}

/** One plain GET, no cookies, nothing about the vault or the device. */
export async function fetchLatest(target: Target): Promise<AvailableUpdate> {
	const url = UPDATE_MANIFEST_URL[target];
	if (!url) throw new Error(`no update manifest for ${target}`);
	// A timer rather than AbortSignal.timeout, which iOS 15 WebViews lack.
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, { credentials: "omit", cache: "no-store", signal: abort.signal });
		if (!res.ok) throw new Error(`manifest: ${res.status}`);
		return parseManifest(target, await res.json());
	} finally {
		clearTimeout(timer);
	}
}
