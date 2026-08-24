import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Browser-agnostic half of the document-bound transport gate. The two specs supply only a way to
// open a URL in their browser; every assertion about the contract lives here, so Chromium and
// Firefox are held to the identical property. See e2e/README.md.
//
// The fixture is a tiny test-only extension, never Bramble: it proves the BROWSER's
// request/reply primitive survives a navigation race. That Bramble uses that primitive is
// proven by the extension unit tests, not here.

const dir = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURE_DIR = path.join(dir, "fixture");
export const SENTINEL = "BRAMBLE_TRANSPORT_SENTINEL";

export type TransportMode = "same-origin" | "cross-origin" | "bfcache";

export type TransportCase = {
	mode: TransportMode;
	/** Entry document. The parent drives the child frame; bfcache navigates the top level. */
	path: string;
	/** Whether the parent reports a reused child frame (false for the top-level bfcache case). */
	requiresFrame: boolean;
};

/**
 * How many times to ask the browser to stage the bfcache case before giving up.
 *
 * Two, not more: five attempts all declined inside eight seconds on the Firefox 128 job, which says
 * the condition is a property of the run rather than of the attempt, so re-rolling it buys almost
 * nothing. One retry still covers a genuine one-off; past that, probeBfcache below is what turns
 * the failure into an answer.
 */
const BFCACHE_STAGING_ATTEMPTS = 2;

/** The three races the advisory requires: same-origin, cross-origin, and a BFCache restore. */
export const TRANSPORT_CASES: readonly TransportCase[] = [
	{ mode: "same-origin", path: "/parent", requiresFrame: true },
	{ mode: "cross-origin", path: "/parent", requiresFrame: true },
	{ mode: "bfcache", path: "/top-a", requiresFrame: false },
];

type ReportedEvent = {
	kind: string;
	role?: "a" | "b";
	documentNonce?: string;
	frameId?: number;
	sentinel?: string;
	reused?: boolean;
	persisted?: boolean;
};

export type RunState = {
	events: ReportedEvent[];
	diagnostics: string[];
	/** Set once the harness is deliberately tearing the browser down, so exit isn't an error. */
	stopping: boolean;
	/** A browser that died or never started; surfaced instead of waiting out the deadline. */
	processError?: string;
	/** Flips when the harness decides the held reply may be delivered. */
	release: boolean;
	aPagehide: boolean;
	bObserved: boolean;
	notify: () => void;
};

/** Opens `url` and resolves a teardown for whatever it opened (a page, or a whole browser). */
export type OpenUrl = (url: string, state: RunState) => Promise<() => Promise<void>>;

export type FixtureServer = {
	/** Origin the fixture is served from. Cross-origin swaps this for `localhost`. */
	base: string;
	runs: Map<string, RunState>;
	close: () => Promise<void>;
};

function newState(): RunState {
	return {
		events: [],
		diagnostics: [],
		stopping: false,
		release: false,
		aPagehide: false,
		bObserved: false,
		notify: () => {},
	};
}

function record(state: RunState, event: ReportedEvent): void {
	state.events.push(event);
	if (event.kind === "observed" && event.role === "b") state.bObserved = true;
	if (event.kind === "pagehide" && event.role === "a") state.aPagehide = true;
	state.notify();
}

/**
 * Serves the fixture pages and collects the events its documents report. Binds 0.0.0.0 so the
 * same port answers on both 127.0.0.1 and localhost, which is how the cross-origin case gets a
 * second origin without any DNS or TLS setup.
 */
export async function startFixtureServer(): Promise<FixtureServer> {
	const runs = new Map<string, RunState>();
	const http: Server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
		const run = url.searchParams.get("run") ?? "";

		if (url.pathname === "/report" && request.method === "POST") {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(chunk as Buffer);
			const state = runs.get(run);
			if (state) record(state, JSON.parse(Buffer.concat(chunks).toString()));
			response.statusCode = 204;
			response.end();
			return;
		}
		// The background holds A's reply until the race is genuinely set up: B is in the reused
		// frame and A has already gone away.
		if (url.pathname === "/release") {
			const state = runs.get(run);
			response.end(state?.release && state.bObserved && state.aPagehide ? "release" : "hold");
			return;
		}
		if (url.pathname === "/parent") {
			response.setHeader("content-type", "text/html");
			response.end('<!doctype html><body><script src="/parent.js"></script></body>');
			return;
		}
		if (url.pathname === "/top-a") {
			response.setHeader("content-type", "text/html");
			response.end('<!doctype html><body><script src="/bfcache-a.js"></script></body>');
			return;
		}
		// The control pages carry no role param, so the content script no-ops on them and nothing
		// holds a channel open. See probe-a.js.
		if (url.pathname === "/probe-a") {
			response.setHeader("content-type", "text/html");
			response.end('<!doctype html><body><script src="/probe-a.js"></script></body>');
			return;
		}
		if (url.pathname === "/probe-b") {
			response.setHeader("content-type", "text/html");
			response.end('<!doctype html><body><script src="/probe-b.js"></script></body>');
			return;
		}
		if (url.pathname === "/top-b") {
			response.setHeader("content-type", "text/html");
			response.end('<!doctype html><body><script src="/bfcache-b.js"></script></body>');
			return;
		}
		if (url.pathname === "/child") {
			response.setHeader("content-type", "text/html");
			response.end("<!doctype html><title>child</title>");
			return;
		}
		if (
			[
				"/bfcache-a.js",
				"/bfcache-b.js",
				"/content.js",
				"/parent.js",
				"/probe-a.js",
				"/probe-b.js",
			].includes(url.pathname)
		) {
			response.setHeader("content-type", "text/javascript");
			response.end(await readFile(path.join(FIXTURE_DIR, url.pathname.slice(1))));
			return;
		}
		response.statusCode = 404;
		response.end();
	});

	await new Promise<void>((resolve) => http.listen(0, "0.0.0.0", resolve));
	const address = http.address();
	if (address === null || typeof address === "string")
		throw new Error("fixture server has no port");
	return {
		base: `http://127.0.0.1:${address.port}`,
		runs,
		close: () => new Promise<void>((resolve) => http.close(() => resolve())),
	};
}

/**
 * The browser refused to put A in the back/forward cache, so the restore the case needs never
 * happened. Not a contract violation - the race was never run - which is why runCase retries it
 * and every other failure goes straight up.
 *
 * `browser.sessionhistory.max_total_viewers=3` (set by the spec) removes the reason this used to
 * happen every time: Firefox otherwise sizes the cache from detected RAM and resolves it to 0 on a
 * small machine. What remains is intermittent, only on the 128 floor, and most likely inherent to
 * the case: A navigates while deliberately holding an extension message channel open, which is
 * exactly the kind of thing that can make a document ineligible. That channel IS the test, so it
 * cannot be removed to make staging reliable.
 */
class BfcacheDeclined extends Error {}

/**
 * The environment cannot stage the bfcache case AT ALL: the control page, which holds nothing open,
 * was refused the cache too. Nothing was proven and nothing can be on this machine, which is a
 * different outcome from both a pass and a failure - the specs turn it into a loud runtime skip.
 *
 * Only ever thrown after probeBfcache has actually run and answered. A refusal that the control
 * does NOT reproduce stays a hard failure, because then the case itself is ineligible and that is
 * a fact about the code worth blocking on.
 */
export class BfcacheUnstageable extends Error {}

async function waitFor(
	state: RunState,
	predicate: (events: ReportedEvent[]) => boolean,
	description: string,
): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (!predicate(state.events)) {
		if (state.processError) throw new Error(state.processError);
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error(`transport fixture timed out waiting for ${description}`);
		// A pagehide that did not persist is the browser refusing to CACHE the page, which is not
		// the transport misbehaving: the scenario never got staged, so nothing was proven either
		// way. runCase retries on this rather than failing, and only this.
		const declined = state.events.find((e) => e.kind === "pagehide" && e.persisted === false);
		if (declined && description.includes("BFCache"))
			throw new BfcacheDeclined(
				`the browser declined to bfcache ${declined.role} (pagehide persisted=false)`,
			);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				state.notify = () => {};
				reject(
					new Error(
						`transport fixture timed out waiting for ${description}: ${JSON.stringify({
							diagnostics: state.diagnostics,
							eventCount: state.events.length,
							events: state.events.slice(-30),
						})}`,
					),
				);
			}, remaining);
			state.notify = () => {
				clearTimeout(timer);
				state.notify = () => {};
				resolve();
			};
		});
	}
}

function documentNonce(events: ReportedEvent[], role: "a" | "b"): string {
	const nonces = new Set(
		events
			.filter((event) => event.role === role && event.documentNonce)
			.map((event) => event.documentNonce),
	);
	if (nonces.size !== 1) throw new Error(`${role}: document nonce was not stable`);
	return nonces.values().next().value as string;
}

/**
 * The contract. The first three checks are the positive control: they prove the race window was
 * real (one frame reused by two distinct documents), so a frame-addressed reply WOULD have landed
 * in B. Without them a green run would prove nothing.
 */
function assertContract(
	events: ReportedEvent[],
	mode: TransportMode,
	requiresFrame: boolean,
): void {
	const a = events.filter((event) => event.role === "a");
	const b = events.filter((event) => event.role === "b");
	const aObserved = a.find((event) => event.kind === "observed");
	const bObserved = b.find((event) => event.kind === "observed");

	if (requiresFrame && !events.some((event) => event.kind === "frame" && event.reused)) {
		throw new Error(`${mode}: browsing context was not reused`);
	}
	if (!aObserved || !bObserved || aObserved.frameId !== bObserved.frameId) {
		throw new Error(`${mode}: background did not observe the same reused frame ID`);
	}
	if (mode === "bfcache" && (aObserved.frameId !== 0 || bObserved.frameId !== 0)) {
		throw new Error("bfcache: the top-level browsing context must use frame ID 0");
	}
	if (documentNonce(events, "a") === documentNonce(events, "b")) {
		throw new Error(`${mode}: distinct documents shared a nonce`);
	}
	if (!a.some((event) => event.kind === "pagehide")) {
		throw new Error(`${mode}: A did not cancel on pagehide`);
	}
	if (a.some((event) => event.sentinel === SENTINEL || event.kind === "applied")) {
		throw new Error(`${mode}: old or restored A received/applied the sentinel`);
	}
	if (b.some((event) => event.sentinel === SENTINEL || event.kind === "applied")) {
		throw new Error(`${mode}: replacement B received/applied the sentinel`);
	}
	if (mode === "bfcache" && !a.some((event) => event.kind === "restored")) {
		throw new Error("bfcache: A did not restore from BFCache");
	}
}

async function exercise(
	state: RunState,
	mode: TransportMode,
	requiresFrame: boolean,
): Promise<void> {
	await waitFor(
		state,
		(events) =>
			events.some((event) => event.role === "b" && event.kind === "observed") &&
			(!requiresFrame || events.some((event) => event.kind === "frame" && event.reused)) &&
			events.some((event) => event.role === "a" && event.kind === "pagehide"),
		"B frame observation and A pagehide",
	);
	if (mode === "bfcache") {
		await waitFor(
			state,
			(events) => events.some((event) => event.kind === "restored"),
			"A BFCache restore",
		);
	}
	state.release = true;
	await waitFor(
		state,
		(events) => events.some((event) => event.kind === "reply-sent"),
		"held async reply",
	);
	// Give a wrongly-routed reply time to be applied and reported before asserting nobody saw it.
	await new Promise((resolve) => setTimeout(resolve, 150));
	assertContract(state.events, mode, requiresFrame);
}

/**
 * Run the control: a plain page navigating away and back, with the fixture extension installed but
 * nothing held open. Returns whether the browser cached it. Used only to explain a decline, so its
 * own failures are answers rather than errors.
 */
async function probeBfcache(
	open: OpenUrl,
	server: Pick<FixtureServer, "base" | "runs">,
): Promise<boolean> {
	const id = `probe-${crypto.randomUUID()}`;
	const state = newState();
	server.runs.set(id, state);
	let teardown: (() => Promise<void>) | undefined;
	try {
		teardown = await open(`${server.base}/probe-a?run=${id}`, state);
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const pagehide = state.events.find((e) => e.kind === "pagehide");
			if (pagehide) return pagehide.persisted === true;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return false;
	} catch {
		return false;
	} finally {
		state.stopping = true;
		await teardown?.();
		server.runs.delete(id);
	}
}

/**
 * Drive one race to completion in whatever browser `open` provides. Throws on any violation.
 *
 * Staging is retried, the contract is not. A declined bfcache means the browser never set the
 * scenario up; re-running it is not "passing on retry", because no assertion has run yet. Every
 * other failure - including every contract violation - propagates on the first attempt, which is
 * what `retries: 0` in the config is there to protect.
 */
export async function runCase(
	open: OpenUrl,
	server: Pick<FixtureServer, "base" | "runs">,
	testCase: TransportCase,
): Promise<void> {
	const attempts = testCase.mode === "bfcache" ? BFCACHE_STAGING_ATTEMPTS : 1;
	for (let attempt = 1; ; attempt++) {
		try {
			await runOnce(open, server, testCase);
			return;
		} catch (error) {
			if (!(error instanceof BfcacheDeclined) || attempt >= attempts) {
				if (error instanceof BfcacheDeclined) {
					// Which of the two worlds are we in? A plain page with nothing held open is the
					// control: if the browser will not cache THAT either, the machine or its settings
					// are refusing bfcache outright and this case never had a chance. If it will, the
					// refusal is about our page specifically - it navigates while holding an extension
					// message channel open - and that is a fact about the case, not the runner.
					const controlCached = await probeBfcache(open, server);
					if (controlCached) {
						throw new Error(
							`${error.message}, on all ${attempts} attempts. A plain control page WAS cached in ` +
								"the same browser, so the refusal is specific to this case: A navigates while " +
								"holding an extension message channel open. That is the scenario the advisory " +
								"requires, so it cannot simply be removed - and it means this browser cannot " +
								"prove the contract. Do not paper over this one.",
						);
					}
					throw new BfcacheUnstageable(
						`${error.message}, on all ${attempts} attempts, and a plain control page with no ` +
							"extension involvement was refused too: this browser or machine declines bfcache " +
							"outright, so the scenario cannot be staged here and nothing was proven either way. " +
							"The same contract is enforced on every environment that CAN stage it.",
					);
				}
				throw error;
			}
			console.warn(`bfcache staging declined (attempt ${attempt}/${attempts}); retrying`);
		}
	}
}

/** One attempt at one case. */
async function runOnce(
	open: OpenUrl,
	server: Pick<FixtureServer, "base" | "runs">,
	testCase: TransportCase,
): Promise<void> {
	const id = `${testCase.mode}-${crypto.randomUUID()}`;
	const state = newState();
	server.runs.set(id, state);
	const role = testCase.mode === "bfcache" ? "&role=a" : "";
	const url = `${server.base}${testCase.path}?run=${id}&mode=${testCase.mode}${role}`;
	let teardown: (() => Promise<void>) | undefined;
	try {
		teardown = await open(url, state);
		await exercise(state, testCase.mode, testCase.requiresFrame);
	} finally {
		state.stopping = true;
		await teardown?.();
		server.runs.delete(id);
	}
}

/**
 * Stop the spawned-browser (Firefox) driver and everything it started.
 *
 * web-ext runs Firefox as a GRANDCHILD, so signalling only the wrapper leaves a browser window
 * on screen: SIGTERM races web-ext's own cleanup, and the SIGKILL fallback orphans Firefox
 * outright. The spec spawns detached so the wrapper leads a process group, and we signal the
 * whole group. SIGTERM first, to let web-ext remove its temporary profile.
 */
export async function stopProcess(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit");
	// A group kill throws ESRCH once nothing is left in it, which is the outcome we want anyway.
	const signalGroup = (signal: NodeJS.Signals) => {
		try {
			if (child.pid !== undefined) process.kill(-child.pid, signal);
		} catch {
			child.kill(signal);
		}
	};
	signalGroup("SIGTERM");
	await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
	if (child.exitCode === null && child.signalCode === null) {
		signalGroup("SIGKILL");
		await exited;
	}
}
