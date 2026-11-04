import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { e2eBridge } from "../scripts/vite-e2e-bridge.mjs";

// The e2e bridge runs code it is sent inside the vault window. These pin the three things that
// keep that to a test run: the endpoint answers only the harness, only with this run's token, and
// none of it reaches a release build.

const TOKEN = "t".repeat(48);

type Handler = (req: unknown, res: unknown) => void;

/** A dev server stand-in: the middleware the plugin mounts, and the socket it talks to the window over. */
function fakeServer() {
	let handler: Handler | null = null;
	const listeners = new Map<string, (data: unknown) => void>();
	const sent: unknown[] = [];
	const server = {
		middlewares: {
			use: (path: string, h: Handler) => {
				if (path === "/__bramble_e2e") handler = h;
			},
		},
		ws: {
			on: (event: string, cb: (data: unknown) => void) => listeners.set(event, cb),
			send: (payload: unknown) => sent.push(payload),
		},
	};
	return { server, handler: () => handler, listeners, sent };
}

/** Drive one request through the mounted middleware and collect the response. */
function request(
	handler: Handler,
	headers: Record<string, string>,
	body: string,
): Promise<{ status: number; body: string }> {
	return new Promise((done) => {
		const chunks = [body];
		const req = {
			method: "POST",
			headers,
			on: (event: string, cb: (chunk?: string) => void) => {
				if (event === "data") for (const c of chunks) cb(c);
				if (event === "end") cb();
			},
		};
		const res = {
			statusCode: 200,
			setHeader: () => {},
			end: (text = "") => done({ status: res.statusCode, body: text }),
		};
		handler(req, res);
	});
}

function mounted(token: string | undefined) {
	const fake = fakeServer();
	const previous = process.env.BRAMBLE_E2E_TOKEN;
	if (token === undefined) delete process.env.BRAMBLE_E2E_TOKEN;
	else process.env.BRAMBLE_E2E_TOKEN = token;
	try {
		const hook = e2eBridge().configureServer as (server: never) => void;
		hook(fake.server as never);
	} finally {
		if (previous === undefined) delete process.env.BRAMBLE_E2E_TOKEN;
		else process.env.BRAMBLE_E2E_TOKEN = previous;
	}
	return fake;
}

describe("the e2e bridge endpoint", () => {
	it("is not mounted at all without a run token", () => {
		expect(mounted(undefined).handler()).toBeNull();
		expect(mounted("short").handler()).toBeNull();
	});

	it("refuses a request without this run's token", async () => {
		const fake = mounted(TOKEN);
		const answer = await request(
			fake.handler()!,
			{ "x-bramble-e2e": "x".repeat(48) },
			'{"code":"return 1"}',
		);
		expect(answer.status).toBe(403);
		expect(fake.sent).toEqual([]);
	});

	it("refuses anything a browser sends, token or not", async () => {
		const fake = mounted(TOKEN);
		const answer = await request(
			fake.handler()!,
			{ "x-bramble-e2e": TOKEN, origin: "https://evil.example" },
			'{"code":"return 1"}',
		);
		expect(answer.status).toBe(403);
		expect(fake.sent).toEqual([]);
	});

	it("hands the harness's code to the window and returns what it answered", async () => {
		const fake = mounted(TOKEN);
		const pending = request(fake.handler()!, { "x-bramble-e2e": TOKEN }, '{"code":"return 1"}');
		await new Promise((r) => setTimeout(r, 0));
		const sent = fake.sent[0] as { event: string; data: { id: string; code: string } };
		expect(sent.event).toBe("bramble:e2e");
		expect(sent.data.code).toBe("return 1");
		fake.listeners.get("bramble:e2e-result")?.({ id: sent.data.id, ok: true, value: 1 });
		const answer = await pending;
		expect(answer.status).toBe(200);
		expect(JSON.parse(answer.body)).toEqual({ id: sent.data.id, ok: true, value: 1 });
	});
});

describe("a release build", () => {
	it("carries none of the bridge, even with its switches set", () => {
		const out = mkdtempSync(join(tmpdir(), "bramble-release-"));
		try {
			execFileSync("npx", ["vite", "build", "--outDir", out, "--emptyOutDir"], {
				cwd: resolve(import.meta.dirname, ".."),
				env: { ...process.env, VITE_E2E_BRIDGE: "1", BRAMBLE_E2E_TOKEN: TOKEN },
				stdio: "pipe",
			});
			const files: string[] = [];
			const walk = (dir: string) => {
				for (const name of readdirSync(dir)) {
					const path = join(dir, name);
					if (statSync(path).isDirectory()) walk(path);
					else files.push(path);
				}
			};
			walk(out);
			expect(files.length).toBeGreaterThan(0);
			for (const file of files) {
				const text = readFileSync(file, "utf8");
				expect(text, file).not.toContain("bramble:e2e");
				expect(text, file).not.toContain("__bramble_e2e");
			}
		} finally {
			rmSync(out, { recursive: true, force: true });
		}
	}, 120_000);
});
