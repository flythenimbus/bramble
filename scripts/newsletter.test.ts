// node --test scripts/newsletter.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blockingEmail, composeEmail, type Email, WEEK_MS } from "./newsletter.ts";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const at = (ms: number) => new Date(ms).toISOString();
const email = (o: Partial<Email>): Email => ({
	subject: "Bramble Desktop 0.17.0",
	status: "sent",
	publish_date: at(NOW - 3 * 24 * 3600 * 1000),
	creation_date: at(NOW - 3 * 24 * 3600 * 1000),
	...o,
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

	it("blocks on a scheduled email", () => {
		assert.ok(
			blockingEmail([email({ status: "scheduled", publish_date: at(NOW + 3600_000) })], NOW),
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

describe("composeEmail", () => {
	const url = "https://github.com/bramble-sh/bramble/releases/tag/1.38.0-chromium";

	it("keeps the summary and drops the commit list", () => {
		const { subject, body } = composeEmail({
			name: "Chromium Extension 1.38.0",
			body: "Passkeys.\n\n- Fixed a thing.\n\n## All changes (7)\n\n### Features\n\n- feat\n",
			url,
		});
		assert.equal(subject, "Bramble Chromium Extension 1.38.0");
		assert.match(body, /^Passkeys\.\n\n- Fixed a thing\.\n\n\[Full release notes\]/);
		assert.doesNotMatch(body, /All changes/);
		assert.ok(body.includes(url));
	});

	it("falls back to the whole body when there is no summary", () => {
		const { body } = composeEmail({
			name: "Android 0.30.0",
			body: "## All changes (1)\n\n- fix\n",
			url,
		});
		assert.match(body, /All changes/);
	});
});
