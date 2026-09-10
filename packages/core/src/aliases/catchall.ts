import { randomInt } from "../util/password-gen";
import {
	type AliasAccount,
	type AliasClient,
	AliasError,
	type AliasRequest,
	type AliasResult,
} from "./types";

// A domain the user owns, pointed at one inbox by a catch-all or forwarding rule (Migadu,
// Cloudflare Email Routing, Fastmail, or any host with such a rule). Once that exists,
// `anything@theirdomain` already arrives, so an alias is just a string nobody has used and
// Bramble makes it here. No account, no API key, no request. See docs/email-aliases.md.

export const CATCHALL_STYLES = ["words", "characters"] as const;
export type CatchAllStyle = (typeof CATCHALL_STYLES)[number];

export interface CatchAllConfig {
	/** The domain the user owns and has pointed at their inbox. */
	domain?: string;
	/** Shape of the part before the `@`. Defaults to words. */
	style?: CatchAllStyle;
}

/** Lowercase alphanumerics only: the safe intersection of what mail hosts accept in a local
 * part, with no leading or trailing dot to get wrong. */
const CHARS = "abcdefghijkmnpqrstuvwxyz23456789";
const CHAR_LENGTH = 10;
const WORD_COUNT = 2;
/** Enough attempts that a collision has to be systematic rather than unlucky. */
const MAX_ATTEMPTS = 12;

function characterLocalPart(): string {
	let out = "";
	for (let i = 0; i < CHAR_LENGTH; i++) out += CHARS.charAt(randomInt(CHARS.length));
	return out;
}

/**
 * Loaded on demand, exactly as the password generator loads it.
 *
 * A static import here would pull 62 KB of wordlist into every bundle that touches aliases and
 * undo the lazy chunk that generator was careful to arrange. In the extension background, where a
 * restarted service worker cannot fetch a chunk, the module is statically imported by
 * background/password-gen.ts and this resolves from the same bundle rather than over the wire.
 */
async function wordLocalPart(): Promise<string> {
	const { effWordlist } = await import("../util/wordlist-eff");
	const words = effWordlist();
	const picked: string[] = [];
	for (let i = 0; i < WORD_COUNT; i++) picked.push(words[randomInt(words.length)] as string);
	// A two-digit tail so two people who both draw "quiet fox" still differ, and so the shape
	// reads as generated rather than as something the user chose.
	return `${picked.join("-")}-${String(randomInt(100)).padStart(2, "0")}`;
}

/**
 * Whether `domain` is shaped like a domain.
 *
 * Deliberately shallow. Bramble cannot tell whether a catch-all actually works without sending
 * mail, and pretending otherwise would be worse than saying nothing: the UI asks the user to
 * check for themselves. This only catches the obvious slips, an empty box or a pasted address.
 */
export function looksLikeDomain(domain: string): boolean {
	const d = domain.trim().toLowerCase();
	if (!d || d.includes("@") || d.includes(" ") || d.includes("/")) return false;
	return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d);
}

export function createCatchAllClient(cfg: CatchAllConfig): AliasClient {
	return {
		// Nothing to contact and nothing to authenticate, so there is nothing to report. The
		// settings screen offers no "check" for this provider precisely because a truthful one is
		// impossible; see looksLikeDomain.
		async verify(): Promise<AliasAccount> {
			return {};
		},

		async create(req: AliasRequest): Promise<AliasResult> {
			const domain = cfg.domain?.trim().toLowerCase();
			if (!domain || !looksLikeDomain(domain)) {
				throw new AliasError("config", "Add the domain you want aliases on, in Settings.");
			}
			// No server rejects a duplicate here, so the vault's own addresses are the only guard.
			const taken = new Set((req.taken ?? []).map((a) => a.trim().toLowerCase()));
			const make = cfg.style === "characters" ? characterLocalPart : wordLocalPart;
			for (let i = 0; i < MAX_ATTEMPTS; i++) {
				const address = `${await make()}@${domain}`;
				if (!taken.has(address)) return { address };
			}
			// Twelve draws all colliding means something is wrong with the inputs rather than with
			// luck, and silently returning a duplicate would hand the user an address that already
			// belongs to another login.
			throw new AliasError("provider", "Could not make an unused address. Try again.");
		},
	};
}
