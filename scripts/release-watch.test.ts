// node --test scripts/release-watch.test.ts
//
// The desktop release watcher, driven by a scripted fake `gh` so the polling loop runs as written.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	approvalPrompt,
	type Job,
	jobChanges,
	SIGN_JOB,
	watchDesktopRelease,
} from "./release-watch.ts";

const REPO = "o/r";
const SINCE = "2026-10-20T10:00:00Z";
const REQUESTS = "https://app.signpath.io/Web/org/SigningRequests";

const job = (name: string, status: string, conclusion: string | null = null, id = 1): Job => ({
	name,
	status,
	conclusion,
	databaseId: id,
});

describe("approvalPrompt", () => {
	it("prompts once the signing job is running, with the requests page", () => {
		assert.match(approvalPrompt([job(SIGN_JOB, "in_progress")], REQUESTS) ?? "", /SigningRequests/);
	});

	it("says nothing while Windows is still building", () => {
		assert.equal(approvalPrompt([job("Build (unsigned)", "in_progress")], REQUESTS), null);
	});

	it("says nothing once signing is over, since there is nothing left to approve", () => {
		assert.equal(approvalPrompt([job(SIGN_JOB, "completed", "success")], REQUESTS), null);
	});

	it("still prompts without the page, pointing at SignPath's email", () => {
		assert.match(approvalPrompt([job(SIGN_JOB, "in_progress")]) ?? "", /emails you the link/);
	});
});

describe("jobChanges", () => {
	it("reports a job once per change, not once per poll", () => {
		const seen = new Map<string, string>();
		assert.deepEqual(jobChanges([job("Bump", "in_progress")], seen), ["  Bump: in progress"]);
		assert.deepEqual(jobChanges([job("Bump", "in_progress")], seen), []);
		assert.deepEqual(jobChanges([job("Bump", "completed", "success")], seen), ["  Bump: success"]);
	});

	it("says when a job is waiting on an approval", () => {
		assert.deepEqual(jobChanges([job("Publish", "waiting")], new Map()), [
			"  Publish: waiting for your approval",
		]);
	});
});

/** A fake `gh` answering from per-poll scripts, logging each call. */
function fakeGh(s: {
	release: { status: string; conclusion?: string; jobs: Job[] }[];
	signRuns?: { databaseId: number; createdAt: string }[];
	sign?: { status: string; jobs: Job[] }[];
	failReleaseViews?: number;
}) {
	const calls: string[][] = [];
	let releasePolls = 0;
	let signPolls = 0;
	let failures = s.failReleaseViews ?? 0;
	const gh = (args: string[]): string => {
		calls.push(args);
		if (args[0] === "run" && args[1] === "view" && args[2] === "100") {
			if (failures > 0) {
				failures--;
				throw new Error("connection reset by peer");
			}
			const r = s.release[Math.min(releasePolls++, s.release.length - 1)];
			return JSON.stringify({ conclusion: null, ...r });
		}
		if (args[0] === "run" && args[1] === "list") return JSON.stringify(s.signRuns ?? []);
		if (args[0] === "run" && args[1] === "view") {
			const list = s.sign ?? [];
			return JSON.stringify(list[Math.min(signPolls++, list.length - 1)]);
		}
		throw new Error(`unexpected gh ${args.join(" ")}`);
	};
	return { gh, calls };
}

function watch(f: ReturnType<typeof fakeGh>, windows = true) {
	const lines: string[] = [];
	const conclusion = watchDesktopRelease(
		{ repo: REPO, runId: "100", since: SINCE, windows, signpathRequests: REQUESTS, pollMs: 0 },
		{ gh: f.gh, sleep: () => {}, log: (l) => lines.push(l) },
	);
	return { conclusion, lines, out: lines.join("\n") };
}

const running = { status: "in_progress", jobs: [job("Publish", "waiting")] };
const done = {
	status: "completed",
	conclusion: "success",
	jobs: [job("Publish", "completed", "success")],
};

describe("watchDesktopRelease", () => {
	it("prompts to approve once, as soon as the signing job starts", () => {
		const f = fakeGh({
			release: [running, running, running, done],
			signRuns: [{ databaseId: 7, createdAt: "2026-10-20T10:01:00Z" }],
			sign: [
				{ status: "in_progress", jobs: [job("Build (unsigned)", "in_progress", null, 1)] },
				{ status: "in_progress", jobs: [job(SIGN_JOB, "in_progress", null, 2)] },
				{ status: "in_progress", jobs: [job(SIGN_JOB, "in_progress", null, 2)] },
				{ status: "completed", jobs: [job(SIGN_JOB, "completed", "success", 2)] },
			],
		});
		const { conclusion, lines, out } = watch(f);

		assert.equal(conclusion, "success");
		assert.equal(out.split(REQUESTS).length - 1, 1, "the prompt is printed exactly once");
		// Not before the build is done: there is no request to approve yet.
		const prompt = lines.findIndex((l) => l.includes("approve the newest signing request"));
		const building = lines.findIndex((l) => l.includes("Build (unsigned): in progress"));
		assert.ok(building < prompt, "prompted only after the build");
		assert.match(out, /windows: building in https:\/\/github\.com\/o\/r\/actions\/runs\/7/);
		assert.match(out, /windows: Sign with SignPath: success/);
		assert.match(out, /Publish: waiting for your approval/);
	});

	it("does not look for a signing run when the release skips Windows", () => {
		const f = fakeGh({ release: [running, done] });
		watch(f, false);

		assert.ok(!f.calls.some((c) => c[1] === "list"), "no sign-windows lookup");
	});

	it("ignores a signing run older than this release", () => {
		const f = fakeGh({
			release: [running, done],
			signRuns: [{ databaseId: 6, createdAt: "2026-10-20T09:59:00Z" }],
		});
		const { out } = watch(f);

		assert.doesNotMatch(out, /windows: building/);
	});

	it("rides out dropped connections", () => {
		const f = fakeGh({ release: [running, done], failReleaseViews: 3 });

		assert.equal(watch(f, false).conclusion, "success");
	});

	it("gives up after ten failures in a row", () => {
		const f = fakeGh({ release: [running], failReleaseViews: 10 });

		assert.throws(() => watch(f, false), /connection reset/);
	});

	it("returns a failed release as failed", () => {
		const failed = { status: "completed", conclusion: "failure", jobs: [] };
		assert.equal(watch(fakeGh({ release: [failed] }), false).conclusion, "failure");
	});

	it("keeps following the release when the signing run cannot be read", () => {
		const f = fakeGh({
			release: [running, done],
			signRuns: [{ databaseId: 7, createdAt: "2026-10-20T10:01:00Z" }],
		});
		const gh = f.gh;
		f.gh = (args) => {
			if (args[0] === "run" && args[1] === "view" && args[2] === "7") throw new Error("HTTP 502");
			return gh(args);
		};

		assert.equal(watch(f).conclusion, "success");
	});
});
