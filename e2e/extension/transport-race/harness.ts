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
		if (["/bfcache-a.js", "/bfcache-b.js", "/content.js", "/parent.js"].includes(url.pathname)) {
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
		// A pagehide that did not persist is the browser refusing to cache the page, which is a
		// different thing from the transport misbehaving, and worth naming: the generic timeout
		// sends you looking at the extension when the answer is the browser's cache settings.
		const declined = state.events.find((e) => e.kind === "pagehide" && e.persisted === false);
		if (declined && description.includes("BFCache"))
			throw new Error(
				`the browser declined to bfcache ${declined.role} (pagehide persisted=false), so no restore ` +
					"could happen. Check browser.sessionhistory.max_total_viewers; Firefox derives it from " +
					"available memory and resolves it to 0 on a constrained machine.",
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

/** Drive one race to completion in whatever browser `open` provides. Throws on any violation. */
export async function runCase(
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
