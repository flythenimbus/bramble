// node --test scripts/github-commit.test.ts
//
// commitOverReleases runs against a fake `gh` put first on PATH, which answers from a script of
// responses and logs what it was asked, so the retry loop and the refusals are exercised as they
// run, not re-implemented in a mock.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { commitOverReleases, overReleasesRefusal } from "./github-commit.ts";

const RELEASE = new Set([
	"packages/manifests/chromium/manifest.json",
	"packages/manifests/firefox/manifest.json",
	"clients/desktop/src-tauri/tauri.conf.json",
]);
const isReleaseFile = (p: string) => RELEASE.has(p);

describe("overReleasesRefusal", () => {
	const bump = { sha: "a".repeat(40), headline: "chore(release): chromium 1.30.0" };

	it("commits over another target's bump", () => {
		assert.equal(
			overReleasesRefusal({
				commits: [bump],
				changed: ["packages/manifests/chromium/manifest.json"],
				own: ["packages/manifests/firefox/manifest.json"],
				isReleaseFile,
			}),
			null,
		);
	});

	it("refuses a commit that is not a release", () => {
		const why = overReleasesRefusal({
			commits: [bump, { sha: "b".repeat(40), headline: "fix(core): something real" }],
			changed: ["packages/manifests/chromium/manifest.json"],
			own: [],
			isReleaseFile,
		});
		assert.match(why ?? "", /not a release commit/);
	});

	it("refuses a release commit that touched code", () => {
		const why = overReleasesRefusal({
			commits: [bump],
			changed: ["packages/core/src/index.ts"],
			own: [],
			isReleaseFile,
		});
		assert.match(why ?? "", /not release metadata/);
	});

	it("refuses a bump of a file this release writes, which it would overwrite", () => {
		const why = overReleasesRefusal({
			commits: [bump],
			changed: ["packages/manifests/firefox/manifest.json"],
			own: ["packages/manifests/firefox/manifest.json"],
			isReleaseFile,
		});
		assert.match(why ?? "", /this release writes it too/);
	});
});

describe("commitOverReleases", () => {
	const REPO = "o/r";
	const BASE = "1".repeat(40);
	const CHROME_BUMP = "2".repeat(40);
	const DESKTOP_BUMP = "3".repeat(40);
	const CODE = "4".repeat(40);
	let dir: string;
	let own: string;

	/** Responses in order per kind; the fake logs every call as a JSON line. */
	function script(s: {
		heads: string[];
		compare?: Record<string, unknown>;
		graphql: ("stale" | string)[];
	}) {
		writeFileSync(join(dir, "script.json"), JSON.stringify(s));
	}
	const log = () =>
		readFileSync(join(dir, "log"), "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as { kind: string; expected?: string });

	const bump = (sha: string, headline: string, filename: string) => ({
		status: "ahead",
		total_commits: 1,
		commits: [{ sha, commit: { message: `${headline}\n\nbody` } }],
		files: [{ filename }],
	});

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
		own = join(dir, "manifest.json");
		writeFileSync(own, '{"version":"1.27.0"}');
		writeFileSync(join(dir, "log"), "");
		const fake = join(dir, "gh");
		writeFileSync(
			fake,
			`#!/usr/bin/env node
const fs = require("node:fs");
const dir = ${JSON.stringify(dir)};
const s = JSON.parse(fs.readFileSync(dir + "/script.json", "utf8"));
const n = JSON.parse(fs.existsSync(dir + "/n.json") ? fs.readFileSync(dir + "/n.json", "utf8") : "{}");
const take = (k) => { const i = n[k] ?? 0; n[k] = i + 1; fs.writeFileSync(dir + "/n.json", JSON.stringify(n)); return s[k][i]; };
const args = process.argv.slice(2);
const logIt = (o) => fs.appendFileSync(dir + "/log", JSON.stringify(o) + "\\n");
if (args[1] === "graphql") {
	const body = JSON.parse(fs.readFileSync(0, "utf8"));
	const expected = body.variables.input.expectedHeadOid;
	logIt({ kind: "commit", expected });
	const r = take("graphql");
	if (r === "stale") {
		process.stdout.write(JSON.stringify({ data: { createCommitOnBranch: null }, errors: [{ type: "STALE_DATA", message: "Expected branch to point to " + expected + " but it did not." }] }));
		process.exit(1);
	}
	process.stdout.write(JSON.stringify({ data: { createCommitOnBranch: { commit: { oid: r } } } }));
} else if (args[1].includes("/git/ref/heads/")) {
	logIt({ kind: "head" });
	process.stdout.write(take("heads") + "\\n");
} else if (args[1].includes("/compare/")) {
	const range = args[1].split("/compare/")[1];
	logIt({ kind: "compare", range });
	process.stdout.write(JSON.stringify(s.compare[range]));
} else { process.stderr.write("unexpected: " + args.join(" ")); process.exit(2); }
`,
		);
		chmodSync(fake, 0o755);
		process.env.PATH = `${dir}:${process.env.PATH}`;
		delete process.env.BRAMBLE_COMMIT_TOKEN;
	});

	const commit = () =>
		commitOverReleases({
			repo: REPO,
			branch: "main",
			base: BASE,
			headline: "chore(release): firefox 1.27.0",
			files: [own],
			isReleaseFile,
		});

	it("commits on the base when nothing landed", () => {
		script({ heads: [BASE], graphql: ["new"] });
		assert.equal(commit(), "new");
		assert.deepEqual(
			log().map((l) => l.kind),
			["head", "commit"],
		);
		assert.equal(log()[1]?.expected, BASE);
	});

	it("commits over another target's bump, onto the new head", () => {
		script({
			heads: [CHROME_BUMP],
			compare: {
				[`${BASE}...${CHROME_BUMP}`]: bump(
					CHROME_BUMP,
					"chore(release): chromium 1.30.0",
					"packages/manifests/chromium/manifest.json",
				),
			},
			graphql: ["new"],
		});
		assert.equal(commit(), "new");
		assert.equal(log().at(-1)?.expected, CHROME_BUMP);
	});

	it("refuses when code landed, and never tries to commit", () => {
		script({
			heads: [CODE],
			compare: {
				[`${BASE}...${CODE}`]: bump(CODE, "feat(core): a change", "packages/core/src/x.ts"),
			},
			graphql: [],
		});
		assert.throws(commit, /cannot be committed over: .*not a release commit/);
		assert.equal(log().filter((l) => l.kind === "commit").length, 0);
	});

	it("refuses when the base is no longer on the branch", () => {
		script({
			heads: [CHROME_BUMP],
			compare: {
				[`${BASE}...${CHROME_BUMP}`]: {
					status: "diverged",
					total_commits: 0,
					commits: [],
					files: [],
				},
			},
			graphql: [],
		});
		assert.throws(commit, /is diverged of/);
	});

	it("refuses when more landed than the compare API lists", () => {
		const listed = bump(
			CHROME_BUMP,
			"chore(release): chromium 1.30.0",
			"packages/manifests/chromium/manifest.json",
		);
		script({
			heads: [CHROME_BUMP],
			compare: { [`${BASE}...${CHROME_BUMP}`]: { ...listed, total_commits: 300 } },
			graphql: [],
		});
		assert.throws(commit, /too much landed/);
	});

	it("retries a race: another bump lands between the check and the write", () => {
		script({
			heads: [CHROME_BUMP, DESKTOP_BUMP],
			compare: {
				[`${BASE}...${CHROME_BUMP}`]: bump(
					CHROME_BUMP,
					"chore(release): chromium 1.30.0",
					"packages/manifests/chromium/manifest.json",
				),
				[`${BASE}...${DESKTOP_BUMP}`]: {
					status: "ahead",
					total_commits: 2,
					commits: [
						{ sha: CHROME_BUMP, commit: { message: "chore(release): chromium 1.30.0" } },
						{ sha: DESKTOP_BUMP, commit: { message: "chore(release): desktop 0.10.0" } },
					],
					files: [
						{ filename: "packages/manifests/chromium/manifest.json" },
						{ filename: "clients/desktop/src-tauri/tauri.conf.json" },
					],
				},
			},
			graphql: ["stale", "new"],
		});
		assert.equal(commit(), "new");
		assert.deepEqual(
			log()
				.filter((l) => l.kind === "commit")
				.map((l) => l.expected),
			[CHROME_BUMP, DESKTOP_BUMP],
		);
	});
});
