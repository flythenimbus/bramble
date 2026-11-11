// node scripts/newsletter.ts <tag>
//
// Emails release notes to the Buttondown newsletter: one email per batch of releases, at most one
// every seven days. Run by .github/workflows/newsletter.yml after each release that asked for it;
// runs are serialized, so each sees what the last one did.
//
// Releases finish at different times, so the email is not sent straight away. The first release
// schedules it SEND_DELAY_MS out; each later one rebuilds it from every release in the batch and
// pushes the send time back again. The batch's tags live in the email's metadata. Any other email
// in the last seven days, a hand-written one included, means this release is skipped with a notice.
//
// The body has one section for changes every platform got and one per platform group. The merge
// is drafted by the same model as the release notes (DEEPSEEK_API_KEY); without one, or when its
// answer does not check out, each group lists its own notes and there is no general section.
//
// Env: BUTTONDOWN_API_KEY, GH_TOKEN, GITHUB_REPOSITORY, DEEPSEEK_API_KEY (optional).

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chat } from "./i18n/ollama.mjs";

const API = "https://api.buttondown.com/v1";
const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;
export const SEND_DELAY_MS = 60 * 60 * 1000;
const TAGS_KEY = "bramble_release_tags";

// Every status where subscribers got, or are about to get, the email. Not draft, errored, deleted.
export const SENDING = [
	"about_to_send",
	"scheduled",
	"in_flight",
	"paused",
	"sent",
	"throttled",
	"resending",
] as const;

export const SECTIONS = {
	desktop: "Desktop (macOS, Linux, Windows)",
	browser: "Browser extensions",
	mobile: "Mobile",
} as const;
export type Section = keyof typeof SECTIONS;
const ORDER: Section[] = ["desktop", "browser", "mobile"];

export interface Email {
	id: string;
	subject: string;
	status: string;
	publish_date: string | null;
	creation_date: string;
	metadata?: Record<string, unknown>;
}

export interface Release {
	tag: string;
	name: string;
	body: string;
	url: string;
}

export interface Merged {
	general: string[];
	sections: Partial<Record<Section, string[]>>;
}

export function sectionOf(tag: string): Section {
	if (tag.endsWith("-desktop")) return "desktop";
	if (tag.endsWith("-chromium") || tag.endsWith("-firefox")) return "browser";
	if (tag.endsWith("-android")) return "mobile";
	throw new Error(`no newsletter section for ${tag}`);
}

const batchTags = (e: Email): string[] | undefined => {
	const tags = e.metadata?.[TAGS_KEY];
	return Array.isArray(tags) ? (tags as string[]) : undefined;
};

/** The email that blocks a send now, if any: one sent in the last week, or one still going out. */
export function blockingEmail(emails: Email[], now: number): Email | undefined {
	return emails.find((e) => {
		if (!(SENDING as readonly string[]).includes(e.status)) return false;
		const when = Date.parse(e.publish_date ?? e.creation_date);
		return Number.isNaN(when) || when > now - WEEK_MS;
	});
}

export type Plan =
	| { kind: "update"; email: Email; tags: string[] }
	| { kind: "create"; tags: string[] }
	| { kind: "skip"; blocker: Email };

/** Join the batch still waiting to send, else start one, unless another email went out this week. */
export function plan(emails: Email[], tag: string, now: number): Plan {
	const pending = emails.find((e) => e.status === "scheduled" && batchTags(e));
	if (pending) {
		const tags = batchTags(pending) as string[];
		return { kind: "update", email: pending, tags: tags.includes(tag) ? tags : [...tags, tag] };
	}
	const blocker = blockingEmail(emails, now);
	return blocker ? { kind: "skip", blocker } : { kind: "create", tags: [tag] };
}

/** A release's points: the lead paragraph and each bullet above "All changes". */
export function points(body: string): string[] {
	const summary = body.split(/^## All changes/m)[0] ?? "";
	return summary
		.split(/\n\s*\n|\n(?=- )/)
		.map((p) => p.replace(/^- /, "").replace(/\s+/g, " ").trim())
		.filter(Boolean);
}

const norm = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();

/** No model: each group lists its releases' points, exact repeats dropped. */
export function fallbackMerge(releases: Release[]): Merged {
	const sections: Merged["sections"] = {};
	for (const r of releases) {
		const key = sectionOf(r.tag);
		const list = sections[key] ?? [];
		sections[key] = list;
		for (const p of points(r.body)) if (!list.some((q) => norm(q) === norm(p))) list.push(p);
	}
	return { general: [], sections };
}

const SYSTEM =
	"You merge release notes for the newsletter of Bramble, an open-source password manager. You " +
	"get the notes of several releases, each labelled with its section: desktop, browser or " +
	"mobile. Several releases can share a section (the Chrome and Firefox extensions are both " +
	"browser).\n\n" +
	"Rules:\n" +
	"- Points that say the same thing in different releases become one point.\n" +
	'- A point goes in "general" only if every section you were given has it. Otherwise it goes in ' +
	"each section that has it.\n" +
	"- A point only one browser got names that browser.\n" +
	"- Every input point appears in the output. Claim nothing the inputs do not say.\n" +
	"- Reuse the inputs' wording, choosing the clearest. One sentence each, ending in a full stop. " +
	"No marketing, no emoji, no em dashes.\n" +
	'- Answer with JSON only: {"general": [...], "desktop": [...], "browser": [...], "mobile": [...]}, ' +
	"leaving out sections you were not given.";

/** The model's answer, if it is the shape asked for and covers only the sections given. */
export function parseMerge(text: string, given: Section[]): Merged | null {
	try {
		const raw = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Record<
			string,
			unknown
		>;
		const list = (v: unknown) =>
			Array.isArray(v) && v.every((s) => typeof s === "string" && s.trim())
				? (v as string[]).map((s) => s.replace(/^- /, "").trim())
				: null;
		const general = raw.general === undefined ? [] : list(raw.general);
		if (!general || (general.length && given.length < 2)) return null;
		const sections: Merged["sections"] = {};
		for (const [key, value] of Object.entries(raw)) {
			if (key === "general") continue;
			if (!given.includes(key as Section)) return null;
			const items = list(value);
			if (!items) return null;
			if (items.length) sections[key as Section] = items;
		}
		const total = general.length + Object.values(sections).flat().length;
		return total ? { general, sections } : null;
	} catch {
		return null;
	}
}

export async function merge(releases: Release[]): Promise<Merged> {
	const fallback = fallbackMerge(releases);
	const given = ORDER.filter((s) => fallback.sections[s]);
	if (releases.length < 2) return fallback;
	try {
		const input = releases
			.map(
				(r) =>
					`[${sectionOf(r.tag)}] ${r.name}\n${points(r.body)
						.map((p) => `- ${p}`)
						.join("\n")}`,
			)
			.join("\n\n");
		const merged = parseMerge(await chat(SYSTEM, input), given);
		if (merged) return merged;
		console.log(
			"::warning::the model's merge did not check out; each platform lists its own notes",
		);
	} catch (e) {
		console.log(
			`::warning::could not merge the notes (${(e as Error).message}); each platform lists its own`,
		);
	}
	return fallback;
}

export function render(
	merged: Merged,
	releases: Release[],
	now: number,
): { subject: string; body: string } {
	const day = new Date(now).toLocaleDateString("en-US", {
		month: "long",
		day: "numeric",
		timeZone: "UTC",
	});
	const block = (title: string, items: string[]) =>
		`## ${title}\n\n${items.map((i) => `- ${i}`).join("\n")}`;
	const blocks = [
		merged.general.length ? block("General updates", merged.general) : "",
		...ORDER.map((s) => (merged.sections[s]?.length ? block(SECTIONS[s], merged.sections[s]) : "")),
	].filter(Boolean);
	const links = releases.map((r) => `[${r.name}](${r.url})`).join(" · ");
	return {
		subject: `What's new in Bramble, ${day}`,
		body: `${blocks.join("\n\n")}\n\nFull release notes: ${links}\n\n[Download Bramble](https://bramble.sh/#download)\n`,
	};
}

async function buttondown(path: string, init: RequestInit = {}): Promise<unknown> {
	const key = process.env.BUTTONDOWN_API_KEY;
	if (!key) throw new Error("BUTTONDOWN_API_KEY is not set");
	const res = await fetch(`${API}${path.replace(API, "")}`, {
		...init,
		headers: { Authorization: `Token ${key}`, "Content-Type": "application/json", ...init.headers },
	});
	if (!res.ok)
		throw new Error(
			`Buttondown ${init.method ?? "GET"} ${path} ${res.status}: ${await res.text()}`,
		);
	return res.json();
}

async function recentEmails(now: number): Promise<Email[]> {
	// The date filter is day-granular, so ask from a day early and compare exact times in code.
	const since = new Date(now - WEEK_MS - DAY_MS).toISOString().slice(0, 10);
	const statuses = SENDING.map((s) => `status=${s}`).join("&");
	const emails: Email[] = [];
	// Two queries: dated emails in the window, and any still in flight, whose date may not be set.
	for (const first of [
		`/emails?${statuses}&publish_date__start=${since}&excluded_fields=body`,
		"/emails?status=about_to_send&status=in_flight&excluded_fields=body",
	]) {
		let url: string | null = first;
		while (url) {
			const page = (await buttondown(url)) as { results: Email[]; next: string | null };
			emails.push(...page.results);
			url = page.next;
		}
	}
	return emails;
}

function release(tag: string): Release & { isDraft: boolean; isPrerelease: boolean } {
	const repo = process.env.GITHUB_REPOSITORY ?? "";
	const fields = "name,body,url,isDraft,isPrerelease";
	const out = execFileSync("gh", ["release", "view", tag, "--repo", repo, "--json", fields], {
		encoding: "utf8",
	});
	return { tag, ...JSON.parse(out) };
}

async function main(tag: string): Promise<void> {
	const own = release(tag);
	if (own.isDraft || own.isPrerelease) {
		console.log(`::notice::${tag} is not a published release; no email`);
		return;
	}

	const now = Date.now();
	const next = plan(await recentEmails(now), tag, now);
	if (next.kind === "skip") {
		const b = next.blocker;
		console.log(
			`::notice::No email for ${tag}: "${b.subject}" (${b.status}, ` +
				`${b.publish_date ?? b.creation_date}) went out in the last 7 days`,
		);
		return;
	}

	const releases = next.tags.map((t) => (t === tag ? own : release(t)));
	const email = render(await merge(releases), releases, now);
	const payload = JSON.stringify({
		...email,
		status: "scheduled",
		publish_date: new Date(now + SEND_DELAY_MS).toISOString(),
		metadata: { [TAGS_KEY]: next.tags },
	});
	if (next.kind === "update")
		await buttondown(`/emails/${next.email.id}`, { method: "PATCH", body: payload });
	else await buttondown("/emails", { method: "POST", body: payload });
	console.log(
		`::notice::"${email.subject}" (${next.tags.join(", ")}) sends at ` +
			`${new Date(now + SEND_DELAY_MS).toISOString()} unless another release joins it first`,
	);
	console.log(email.body);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const tag = process.argv[2];
	if (!tag) {
		console.error("usage: node scripts/newsletter.ts <tag>");
		process.exit(2);
	}
	main(tag).catch((e: Error) => {
		console.error(`::error::${e.message}`);
		process.exit(1);
	});
}
