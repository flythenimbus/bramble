// node --test scripts/publish-release-notes.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	batch,
	blockingEmail,
	blogPost,
	type Email,
	fallbackMerge,
	type Intent,
	intentOf,
	type Job,
	type Published,
	parseMerge,
	points,
	previewReleases,
	type Release,
	type RunIntent,
	render,
	WEEK_MS,
} from "./publish-release-notes.ts";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const at = (ms: number) => new Date(ms).toISOString();
const email = (o: Partial<Email>): Email => ({
	subject: "Something",
	status: "sent",
	publish_date: at(NOW - 3 * 24 * 3600 * 1000),
	creation_date: at(NOW - 3 * 24 * 3600 * 1000),
	...o,
});
const rel = (tag: string, name: string, body: string): Release => ({
	tag,
	name,
	body,
	url: `https://github.com/bramble-sh/bramble/releases/tag/${tag}`,
});

describe("blockingEmail", () => {
	it("blocks on an email sent in the last 7 days", () => {
		assert.ok(blockingEmail([email({})], NOW));
	});

	it("allows once 7 days have passed", () => {
		assert.equal(
			blockingEmail([email({ publish_date: at(NOW - WEEK_MS - 1000) })], NOW),
			undefined,
		);
	});

	it("blocks on an email still going out, which may have no publish date", () => {
		assert.ok(
			blockingEmail(
				[email({ status: "about_to_send", publish_date: null, creation_date: at(NOW) })],
				NOW,
			),
		);
	});

	it("ignores drafts and failed sends", () => {
		assert.equal(
			blockingEmail([email({ status: "draft" }), email({ status: "errored" })], NOW),
			undefined,
		);
	});

	it("blocks when the date cannot be read", () => {
		assert.ok(blockingEmail([email({ publish_date: "garbage" })], NOW));
	});
});

describe("intentOf", () => {
	const job = (status: string, conclusion: string | null, name = "Publish release notes"): Job => ({
		name,
		status,
		conclusion,
	});

	it("is yes when the intent job ran", () => {
		assert.equal(intentOf([job("completed", "success")]), "yes");
	});

	it("is no when it was skipped", () => {
		assert.equal(intentOf([job("completed", "skipped")]), "no");
	});

	it("is unknown before GitHub has decided, or with no such job", () => {
		assert.equal(intentOf([job("queued", null)]), "unknown");
		assert.equal(intentOf([]), "unknown");
		assert.equal(intentOf([job("completed", "success", "Build (unsigned)")]), "unknown");
	});
});

describe("batch", () => {
	const HOUR = 3600_000;
	let id = 0;
	const run = (
		suffix: string,
		intent: Intent,
		status = "completed",
		start = 3 * HOUR,
	): RunIntent => ({
		id: ++id,
		name: `${suffix} release`,
		status,
		created_at: at(NOW - start),
		updated_at: at(NOW - start + 2 * HOUR),
		suffix,
		intent,
	});
	const pub = (tag: string, ago: number): Published => ({
		tag,
		name: tag,
		body: "",
		url: `https://example.test/${tag}`,
		published_at: at(NOW - ago),
	});

	it("waits while another run that asked for an email, or might have, is going", () => {
		const b = batch(
			[
				run("chromium", "yes"),
				run("desktop", "yes", "waiting"),
				run("android", "no", "in_progress"),
				run("firefox", "unknown", "queued"),
			],
			[pub("1.38.0-chromium", 2 * HOUR)],
			NOW,
		);
		assert.deepEqual(b.waiting, [`desktop release (run ${id - 2})`, `firefox release (run ${id})`]);
		assert.deepEqual(
			b.releases.map((r) => r.tag),
			["1.38.0-chromium"],
		);
	});

	it("finds each run's release by suffix and publish time, in section order", () => {
		const b = batch(
			[run("android", "yes"), run("chromium", "yes"), run("desktop", "yes")],
			[
				pub("0.30.0-android", 2 * HOUR),
				pub("0.29.0-android", 50 * HOUR), // an earlier release, outside this run
				pub("1.38.0-chromium", 2 * HOUR),
				pub("0.18.0-desktop", 2 * HOUR),
			],
			NOW,
		);
		assert.deepEqual(
			b.releases.map((r) => r.tag),
			["0.18.0-desktop", "1.38.0-chromium", "0.30.0-android"],
		);
	});

	it("leaves out runs that did not ask, did not publish, or are over a week old", () => {
		const b = batch(
			[
				run("chromium", "no"),
				run("firefox", "yes"),
				run("android", "yes", "completed", WEEK_MS + HOUR),
			],
			[pub("1.38.0-chromium", 2 * HOUR), pub("0.29.0-android", WEEK_MS)],
			NOW,
		);
		assert.deepEqual(b, { waiting: [], releases: [] });
	});
});

describe("points", () => {
	it("takes the lead paragraph and bullets, not the commit list", () => {
		assert.deepEqual(points("Lead.\n\n- One.\n- Two.\n\n## All changes (2)\n\n- feat\n"), [
			"Lead.",
			"One.",
			"Two.",
		]);
	});
});

describe("fallbackMerge", () => {
	it("groups by platform and drops exact repeats", () => {
		const m = fallbackMerge([
			rel("1.38.0-chromium", "Chromium Extension 1.38.0", "- Shared fix.\n- Chrome thing."),
			rel("1.35.0-firefox", "Firefox Extension 1.35.0", "- Shared fix!\n- Firefox thing."),
			rel("0.29.0-android", "Android 0.29.0", "- Phone thing."),
		]);
		assert.deepEqual(m, {
			general: [],
			sections: {
				browser: ["Shared fix.", "Chrome thing.", "Firefox thing."],
				mobile: ["Phone thing."],
			},
		});
	});
});

describe("parseMerge", () => {
	const given = ["desktop", "browser"] as const;

	it("accepts the asked-for shape, even wrapped in prose", () => {
		const m = parseMerge('Here:\n{"general": ["A."], "desktop": ["B."], "browser": []}', [
			...given,
		]);
		assert.deepEqual(m, { general: ["A."], sections: { desktop: ["B."] } });
	});

	it("refuses a section it was not given", () => {
		assert.equal(parseMerge('{"general": [], "mobile": ["X."]}', [...given]), null);
	});

	it("refuses a general section from a single platform", () => {
		assert.equal(parseMerge('{"general": ["A."], "desktop": []}', ["desktop"]), null);
	});

	it("refuses junk and empty answers", () => {
		assert.equal(parseMerge("no", [...given]), null);
		assert.equal(parseMerge('{"general": [], "desktop": [1]}', [...given]), null);
		assert.equal(parseMerge('{"general": []}', [...given]), null);
	});
});

describe("render", () => {
	it("puts general first, then platforms in a fixed order, then the links", () => {
		const releases = [
			rel("0.29.0-android", "Android 0.29.0", ""),
			rel("0.17.0-desktop", "Desktop 0.17.0", ""),
		];
		const { subject, body } = render(
			{ general: ["G."], sections: { mobile: ["M."], desktop: ["D."] } },
			releases,
			NOW,
		);
		assert.equal(subject, "What's new in Bramble, November 11");
		assert.match(
			body,
			/^## General updates\n\n- G\.\n\n## Desktop \(macOS, Linux, Windows\)\n\n- D\.\n\n## Mobile\n\n- M\.\n\nFull release notes: \[Android 0\.29\.0\]/,
		);
	});

	it("leaves out an empty general section", () => {
		const { body } = render({ general: [], sections: { browser: ["B."] } }, [], NOW);
		assert.match(body, /^## Browser extensions/);
	});
});

describe("blogPost", () => {
	it("dates the post and keeps the email's title and text", () => {
		const releases = ["Desktop 0.18.0", "Chromium Extension 1.39.0", "Android 0.30.0"].map(
			(name) => ({
				tag: "x",
				name,
				body: "",
				url: "",
			}),
		);
		const post = blogPost(
			{ subject: "What's new in Bramble, November 11", body: "## General updates\n\n- G.\n" },
			releases,
			NOW,
		);
		assert.equal(post.path, "website/src/content/blog/whats-new-2026-11-11.md");
		assert.equal(
			post.content,
			'---\ntitle: "What\'s new in Bramble, November 11"\n' +
				'description: "What changed in Desktop 0.18.0, Chromium Extension 1.39.0 and Android 0.30.0."\n' +
				"pubDate: 2026-11-11\n---\n\n## General updates\n\n- G.\n",
		);
	});
});

describe("previewReleases", () => {
	const pub = (tag: string): Published => ({ ...rel(tag, tag, ""), published_at: at(NOW) });
	const all = [
		pub("1.38.0-chromium"),
		pub("0.29.0-android"),
		pub("1.37.0-chromium"),
		pub("0.17.0-desktop"),
	];

	it("takes each workflow's newest, desktop first", () => {
		assert.deepEqual(
			previewReleases(all, []).map((r) => r.tag),
			["0.17.0-desktop", "1.38.0-chromium", "0.29.0-android"],
		);
	});

	it("takes the tags asked for", () => {
		assert.deepEqual(
			previewReleases(all, ["1.37.0-chromium"]).map((r) => r.tag),
			["1.37.0-chromium"],
		);
	});

	it("refuses a tag that is not published", () => {
		assert.throws(() => previewReleases(all, ["9.9.9-firefox"]), /no published release/);
	});
});
