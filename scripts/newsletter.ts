// node scripts/newsletter.ts draft <email.json>
// node scripts/newsletter.ts send <email.json>
//
// One Buttondown email per batch of releases, at most one every seven days, read by a person before
// it sends. .github/workflows/newsletter.yml runs `draft` whenever a release run finishes; only runs
// dispatched with `--email` take part. Those run a no-op job, "Email subscribers", that is skipped
// otherwise: the API does not show a run's inputs, but it does show its jobs. A run's release is
// the one with its workflow's tag suffix published while it ran.
//
// - While another such run is still going, `draft` does nothing: the last one to finish drafts for
//   all of them, so releases approved hours apart still share one email.
// - Any email in the last seven days, a hand-written one included, means no email.
// - Otherwise every such release published in the last seven days goes in, merged by the
//   release-notes model (DEEPSEEK_API_KEY) into a section for what every platform got and one per
//   platform group. Without the model, or when its answer does not check out, each group lists its
//   own notes and there is no general section.
//
// The draft goes to the run summary. `send` runs only after an approval in the `newsletter`
// environment, checks the week again, commits the same text as a blog post on the website (through
// the release app, which may commit to main; the push deploys the site), then sends the email.
//
// Env: GH_TOKEN, GITHUB_REPOSITORY, BUTTONDOWN_API_KEY (read-only for draft, sending for send),
// DEEPSEEK_API_KEY (draft, optional), BRAMBLE_COMMIT_TOKEN (send), GITHUB_STEP_SUMMARY,
// GITHUB_OUTPUT.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { commitFiles } from "./github-commit.ts";
import { chat } from "./i18n/ollama.mjs";

const API = "https://api.buttondown.com/v1";
const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;

/** Each release workflow and the suffix of the tags it publishes. */
export const WORKFLOWS: Record<string, string> = {
	"desktop-release.yml": "desktop",
	"chrome-release.yml": "chromium",
	"firefox-release.yml": "firefox",
	"android-release.yml": "android",
};

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
	subject: string;
	status: string;
	publish_date: string | null;
	creation_date: string;
}

export interface Run {
	id: number;
	name: string;
	status: string;
	created_at: string;
	updated_at: string;
}

export interface Job {
	name: string;
	status: string;
	conclusion: string | null;
}

/** A release run, the tag suffix its workflow publishes, and whether it asked for an email. */
export interface RunIntent extends Run {
	suffix: string;
	intent: Intent;
}
export type Intent = "yes" | "no" | "unknown";

export const INTENT_JOB = "Email subscribers";

export interface Release {
	tag: string;
	name: string;
	body: string;
	url: string;
}

/** A GitHub release as the API lists it. */
export interface Published extends Release {
	published_at: string | null;
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

/**
 * Whether a release run asked for an email, from its jobs: "no" if the intent job was skipped,
 * "unknown" while GitHub has yet to decide, which counts as waiting.
 */
export function intentOf(jobs: Job[]): Intent {
	const job = jobs.find((j) => j.name === INTENT_JOB);
	if (job?.status !== "completed") return "unknown";
	return job.conclusion === "success" ? "yes" : "no";
}

/**
 * Of the runs that asked for an email: the names of those still going, and the releases this
 * week's finished ones published. A finished run with no release failed before publishing; one
 * with no intent job predates it, and never asked.
 */
export function batch(
	runs: RunIntent[],
	releases: Published[],
	now: number,
): { waiting: string[]; releases: Release[] } {
	const waiting: string[] = [];
	const found: Release[] = [];
	for (const r of runs) {
		if (r.intent === "no") continue;
		if (r.status !== "completed") {
			waiting.push(`${r.name} (run ${r.id})`);
			continue;
		}
		if (r.intent !== "yes" || Date.parse(r.created_at) <= now - WEEK_MS) continue;
		const from = Date.parse(r.created_at);
		const to = Date.parse(r.updated_at);
		const release = releases.find((p) => {
			const at = Date.parse(p.published_at ?? "");
			return p.tag.endsWith(`-${r.suffix}`) && at >= from && at <= to;
		});
		if (release && !found.some((f) => f.tag === release.tag))
			found.push({ tag: release.tag, name: release.name, body: release.body, url: release.url });
	}
	found.sort((a, b) => ORDER.indexOf(sectionOf(a.tag)) - ORDER.indexOf(sectionOf(b.tag)));
	return { waiting, releases: found };
}

/** The email that blocks a send now, if any: one sent in the last week, or one still going out. */
export function blockingEmail(emails: Email[], now: number): Email | undefined {
	return emails.find((e) => {
		if (!(SENDING as readonly string[]).includes(e.status)) return false;
		const when = Date.parse(e.publish_date ?? e.creation_date);
		return Number.isNaN(when) || when > now - WEEK_MS;
	});
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

export interface Post {
	path: string;
	content: string;
}

/** The email as a blog post: same title and text, dated the day it was drafted. */
export function blogPost(
	email: { subject: string; body: string },
	releases: Release[],
	now: number,
): Post {
	const day = new Date(now).toISOString().slice(0, 10);
	const names = releases.map((r) => r.name);
	const list =
		names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
	// JSON strings are valid YAML double-quoted scalars, so quoting is JSON.stringify.
	return {
		path: `website/src/content/blog/whats-new-${day}.md`,
		content:
			`---\ntitle: ${JSON.stringify(email.subject)}\n` +
			`description: ${JSON.stringify(`What changed in ${list}.`)}\n` +
			`pubDate: ${day}\n---\n\n${email.body}`,
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

const repo = () => process.env.GITHUB_REPOSITORY ?? "";
const gh = (args: string[]) => execFileSync("gh", args, { encoding: "utf8" });

const api = <T>(path: string) => JSON.parse(gh(["api", `repos/${repo()}/${path}`])) as T;

function releaseRuns(now: number): RunIntent[] {
	const since = new Date(now - WEEK_MS - DAY_MS).toISOString().slice(0, 10);
	return Object.entries(WORKFLOWS).flatMap(([workflow, suffix]) =>
		api<{ workflow_runs: Run[] }>(
			`actions/workflows/${workflow}/runs?event=workflow_dispatch&created=>=${since}&per_page=100`,
		).workflow_runs.map((r) => ({
			id: r.id,
			name: r.name,
			status: r.status,
			created_at: r.created_at,
			updated_at: r.updated_at,
			suffix,
			intent: intentOf(
				api<{ jobs: Job[] }>(`actions/runs/${r.id}/jobs?filter=latest&per_page=100`).jobs,
			),
		})),
	);
}

/** Published releases, newest first: drafts and prereleases never go in an email. */
function publishedReleases(): Published[] {
	return api<
		{
			tag_name: string;
			name: string;
			body: string | null;
			html_url: string;
			draft: boolean;
			prerelease: boolean;
			published_at: string | null;
		}[]
	>("releases?per_page=100")
		.filter((r) => !r.draft && !r.prerelease)
		.map((r) => ({
			tag: r.tag_name,
			name: r.name,
			body: r.body ?? "",
			url: r.html_url,
			published_at: r.published_at,
		}));
}

const notice = (msg: string) => console.log(`::notice::${msg}`);

/** Commit the post to main, unless it is already there. */
function publishPost(post: Post, title: string): void {
	try {
		gh(["api", `repos/${repo()}/contents/${post.path}?ref=main`, "--jq", ".sha"]);
		notice(`${post.path} is already on main; not committing it again`);
		return;
	} catch {
		// Not there yet.
	}
	writeFileSync(post.path, post.content);
	for (let attempt = 1; ; attempt++) {
		const head = gh(["api", `repos/${repo()}/git/ref/heads/main`, "--jq", ".object.sha"]).trim();
		try {
			commitFiles({
				repo: repo(),
				branch: "main",
				expectedHeadOid: head,
				headline: `docs(blog): ${title}`,
				files: [post.path],
			});
			notice(`Committed ${post.path}; the website deploys from that push`);
			return;
		} catch (e) {
			// Main moved between the read and the commit; the post touches nothing else, so retry.
			const err = e as { stdout?: unknown; message?: string };
			const stale = /STALE_DATA|Expected branch to point to/.test(
				`${err.stdout ?? ""} ${err.message ?? ""}`,
			);
			if (!stale || attempt >= 5) throw e;
		}
	}
}

async function draft(out: string): Promise<void> {
	const now = Date.now();
	const { waiting, releases } = batch(releaseRuns(now), publishedReleases(), now);
	if (waiting.length) {
		notice(`No email yet: ${waiting.join(", ")} still running; the last to finish drafts it`);
		return;
	}
	const blocker = blockingEmail(await recentEmails(now), now);
	if (blocker) {
		notice(
			`No email: "${blocker.subject}" (${blocker.status}, ` +
				`${blocker.publish_date ?? blocker.creation_date}) went out in the last 7 days`,
		);
		return;
	}
	if (!releases.length) {
		notice("No email: no release that asked for one was published this week");
		return;
	}

	const email = render(await merge(releases), releases, now);
	const post = blogPost(email, releases, now);
	writeFileSync(out, JSON.stringify({ ...email, tags: releases.map((r) => r.tag), post }));
	const url = post.path.replace(/^website\/src\/content(\/blog\/.+)\.md$/, "https://bramble.sh$1");
	const summary = process.env.GITHUB_STEP_SUMMARY;
	if (summary)
		appendFileSync(
			summary,
			`# ${email.subject}\n\nApprove the send job to email this to every subscriber and ` +
				`publish it as a blog post at ${url}.\n\n---\n\n${email.body}`,
		);
	const output = process.env.GITHUB_OUTPUT;
	if (output) appendFileSync(output, "ready=true\n");
	console.log(`${email.subject}\n\n${email.body}`);
}

async function send(file: string): Promise<void> {
	const email = JSON.parse(readFileSync(file, "utf8")) as {
		subject: string;
		body: string;
		tags: string[];
		post: Post;
	};
	const now = Date.now();
	// Again: the approval can come days after the draft, and an email may have gone out since.
	const blocker = blockingEmail(await recentEmails(now), now);
	if (blocker)
		throw new Error(`"${blocker.subject}" went out after this was drafted; not sending a second`);
	// The post first: a re-run after a failed send finds it there and goes straight to the email.
	publishPost(email.post, email.subject);
	await buttondown("/emails", {
		method: "POST",
		body: JSON.stringify({
			subject: email.subject,
			body: email.body,
			status: "about_to_send",
			metadata: { bramble_release_tags: email.tags },
		}),
	});
	notice(`Emailed subscribers "${email.subject}"`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [command, file] = process.argv.slice(2);
	if (!file || (command !== "draft" && command !== "send")) {
		console.error("usage: node scripts/newsletter.ts draft|send <email.json>");
		process.exit(2);
	}
	(command === "draft" ? draft(file) : send(file)).catch((e: Error) => {
		console.error(`::error::${e.message}`);
		process.exit(1);
	});
}
