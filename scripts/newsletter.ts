// node scripts/newsletter.ts <tag>
//
// Emails a published release's notes to the Buttondown newsletter, at most once every seven days.
// Any email that went out in the last seven days counts, a hand-written one included, so a second
// release in the same week is skipped (exit 0, with a notice) rather than sent. Run by
// .github/workflows/newsletter.yml, which serializes runs so two releases finishing together
// cannot both pass the check.
//
// Env: BUTTONDOWN_API_KEY, GH_TOKEN, GITHUB_REPOSITORY.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const API = "https://api.buttondown.com/v1";
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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

export interface Email {
	subject: string;
	status: string;
	publish_date: string | null;
	creation_date: string;
}

/** The email that blocks a send now, if any: one sent in the last week, or one still going out. */
export function blockingEmail(emails: Email[], now: number): Email | undefined {
	return emails.find((e) => {
		if (!(SENDING as readonly string[]).includes(e.status)) return false;
		const when = Date.parse(e.publish_date ?? e.creation_date);
		return Number.isNaN(when) || when > now - WEEK_MS;
	});
}

/** Subject and Markdown body from a release. The commit list under "All changes" stays on GitHub. */
export function composeEmail(release: { name: string; body: string; url: string }): {
	subject: string;
	body: string;
} {
	const summary = release.body.split(/^## All changes/m)[0]?.trim() || release.body.trim();
	return {
		subject: `Bramble ${release.name}`,
		body: `${summary}\n\n[Full release notes](${release.url}) · [Download](https://bramble.sh/#download)\n`,
	};
}

async function buttondown(path: string, init: RequestInit = {}): Promise<Response> {
	const key = process.env.BUTTONDOWN_API_KEY;
	if (!key) throw new Error("BUTTONDOWN_API_KEY is not set");
	return fetch(`${API}${path}`, {
		...init,
		headers: { Authorization: `Token ${key}`, "Content-Type": "application/json", ...init.headers },
	});
}

async function recentEmails(now: number): Promise<Email[]> {
	// The date filter is day-granular, so ask from a day early and compare exact times above.
	const since = new Date(now - WEEK_MS - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
	const statuses = SENDING.map((s) => `status=${s}`).join("&");
	const emails: Email[] = [];
	// Two queries: dated emails in the window, and any still in flight, whose date may not be set.
	for (const first of [
		`/emails?${statuses}&publish_date__start=${since}&excluded_fields=body`,
		"/emails?status=about_to_send&status=in_flight&excluded_fields=body",
	]) {
		let url: string | null = first;
		while (url) {
			const res = await buttondown(url.replace(API, ""));
			if (!res.ok) throw new Error(`Buttondown list ${res.status}: ${await res.text()}`);
			const page = (await res.json()) as { results: Email[]; next: string | null };
			emails.push(...page.results);
			url = page.next;
		}
	}
	return emails;
}

async function main(tag: string): Promise<void> {
	const release = JSON.parse(
		execFileSync(
			"gh",
			[
				"release",
				"view",
				tag,
				"--repo",
				process.env.GITHUB_REPOSITORY ?? "",
				"--json",
				"name,body,url,isDraft,isPrerelease",
			],
			{ encoding: "utf8" },
		),
	) as { name: string; body: string; url: string; isDraft: boolean; isPrerelease: boolean };
	if (release.isDraft || release.isPrerelease) {
		console.log(`::notice::${tag} is not a published release; no email`);
		return;
	}

	const now = Date.now();
	const blocker = blockingEmail(await recentEmails(now), now);
	if (blocker) {
		console.log(
			`::notice::No email for ${tag}: "${blocker.subject}" (${blocker.status}, ` +
				`${blocker.publish_date ?? blocker.creation_date}) went out in the last 7 days`,
		);
		return;
	}

	const email = composeEmail(release);
	const res = await buttondown("/emails", {
		method: "POST",
		body: JSON.stringify({ ...email, status: "about_to_send" }),
	});
	if (!res.ok) throw new Error(`Buttondown send ${res.status}: ${await res.text()}`);
	console.log(`::notice::Emailed subscribers "${email.subject}"`);
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
