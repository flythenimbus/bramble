// node --test scripts/newsletter.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	batch,
	blockingEmail,
	type Email,
	fallbackMerge,
	markedTag,
	parseMerge,
	points,
	type Release,
	type Run,
	render,
	WEEK_MS,
} from "./newsletter.ts";

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

describe("markedTag", () => {
	it("reads the tag of a run that asked for an email", () => {
		assert.equal(markedTag("0.17.0-desktop +email"), "0.17.0-desktop");
	});

	it("ignores runs that did not, dry runs and other workflows", () => {
		assert.equal(markedTag("0.17.0-desktop"), null);
		assert.equal(markedTag("Dry run: 0.17.0-desktop"), null);
		assert.equal(markedTag("1.24.0-ios +email"), null);
	});
});

describe("batch", () => {
	const run = (display_title: string, status = "completed", ago = 3600_000): Run => ({
		display_title,
		status,
		created_at: at(NOW - ago),
	});

	it("waits while another run that asked for an email is going", () => {
		const b = batch(
			[
				run("1.38.0-chromium +email"),
				run("0.17.0-desktop +email", "waiting"),
				run("0.30.0-android", "in_progress"),
			],
			NOW,
		);
		assert.deepEqual(b, { waiting: ["0.17.0-desktop"], tags: ["1.38.0-chromium"] });
	});

	it("takes this week's finished runs once each, and nothing older", () => {
		const b = batch(
			[
				run("1.38.0-chromium +email"),
				run("1.38.0-chromium +email"),
				run("1.35.0-firefox +email"),
				run("0.28.0-android +email", "completed", WEEK_MS + 1000),
			],
			NOW,
		);
		assert.deepEqual(b, { waiting: [], tags: ["1.38.0-chromium", "1.35.0-firefox"] });
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
