#!/usr/bin/env node
// Serve a fake update to a locally built Bramble, so the update path can be exercised without
// publishing anything.
//
// What this proves is the whole chain that matters: the app asks, the manifest is read, the
// archive downloads with a length so progress moves, the minisign signature is verified against
// the key compiled into the running app, the bundle is replaced, the app relaunches. That last
// part is the reason this is worth doing at all — an updater that downloads correctly and then
// fails to swap the bundle is indistinguishable from a working one until the day it matters.
//
// It advertises the SAME archive under a higher version number. The signature covers the archive's
// bytes and the version comes from the manifest, so this is a valid update by every check the
// plugin makes; it just installs what is already installed. That keeps the test to one build. The
// app therefore still reports the old version afterwards and will offer the same update again:
// expected, and the reason there is a second, two-build step in the docs for confirming the
// version actually changes.

import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Overridable so this can be exercised against a scratch directory rather than a real build. */
const MACOS =
	process.env.BRAMBLE_SMOKE_BUNDLE ??
	join(ROOT, "packages/platform-desktop/src-tauri/target/release/bundle/macos");
const CONF = join(ROOT, "packages/platform-desktop/src-tauri/tauri.conf.json");
const PATCH = join(ROOT, "packages/platform-desktop/src-tauri/tauri.local-update.conf.json");

const fail = (message: string): never => {
	console.error(`error: ${message}`);
	process.exit(1);
};

// `--slow[=seconds]`. Six megabytes off localhost arrives in milliseconds, so the percentage in
// Settings is gone before it can be read, which makes the one part of the UI worth watching the
// one part you cannot see. Spreading the transfer out is the only way to actually test it.
const slowArg = process.argv.slice(2).find((a) => a === "--slow" || a.startsWith("--slow="));
const SLOW_MS = slowArg ? (Number(slowArg.split("=")[1]) || 10) * 1000 : 0;

/** The port in the patch config, so the two cannot drift. */
function port(): number {
	const patch = JSON.parse(readFileSync(PATCH, "utf8"));
	const endpoint: string | undefined = patch.plugins?.updater?.endpoints?.[0];
	const parsed = endpoint ? Number(new URL(endpoint).port) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fail(`no usable endpoint in ${PATCH}`);
}

/** Next patch version, which is all the plugin compares. */
function bump(version: string): string {
	const [major = "0", minor = "0", patch = "0"] = version.split(".");
	return `${major}.${minor}.${Number(patch) + 1}`;
}

if (!existsSync(MACOS))
	fail(`no bundle at ${MACOS}. Run the build first (see docs/desktop-port.md).`);

const files = await readdir(MACOS);
const archive = files.find((f) => f.endsWith(".app.tar.gz"));
if (!archive)
	// Distinguish "never built" from "built, but the archive is missing" — with an .app sitting
	// right there, being told to check a config flag that is already set sends you the wrong way.
	fail(
		files.some((f) => f.endsWith(".app"))
			? "there is an .app here but no .app.tar.gz. The archive is produced by the build, so\n" +
					"       something removed it; rebuild with `pnpm build:desktop:local-update`."
			: "no build in the bundle directory. Run `pnpm build:desktop:local-update` first.",
	);
if (!files.includes(`${archive}.sig`))
	// Without this the app rejects the download, which looks like a broken updater rather than an
	// unsigned test artifact.
	fail(`${archive} has no .sig. The build needs TAURI_SIGNING_PRIVATE_KEY set.`);

const { version } = JSON.parse(readFileSync(CONF, "utf8"));
const offered = bump(version);
const PORT = port();

const manifest = {
	version: offered,
	notes: `Local smoke test: pretending ${version} is ${offered}.`,
	pub_date: new Date().toISOString(),
	platforms: {
		"darwin-aarch64": {
			signature: readFileSync(join(MACOS, `${archive}.sig`), "utf8").trim(),
			url: `http://127.0.0.1:${PORT}/${archive}`,
		},
		"darwin-x86_64": {
			signature: readFileSync(join(MACOS, `${archive}.sig`), "utf8").trim(),
			url: `http://127.0.0.1:${PORT}/${archive}`,
		},
	},
};
const manifestPath = join(MACOS, "latest.local.json");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const server = createServer((req, res) => {
	const name = decodeURIComponent((req.url ?? "/").slice(1).split("?")[0] ?? "");
	const path = name === "latest.json" ? manifestPath : join(MACOS, name);

	// Only ever out of the bundle directory, so a stray request cannot read the rest of the disk.
	if (!path.startsWith(MACOS) || !existsSync(path)) {
		res.writeHead(404).end("not found");
		console.log(`  404 ${name}`);
		return;
	}
	// Content-Length on purpose: without it the plugin reports no total and the UI can only show a
	// spinner, so the percentage would go untested.
	res.writeHead(200, {
		"content-type": name.endsWith(".json") ? "application/json" : "application/octet-stream",
		"content-length": statSync(path).size,
	});
	const size = statSync(path).size;
	const throttle = SLOW_MS > 0 && name !== "latest.json";
	console.log(`  200 ${name} (${size} bytes)${throttle ? " throttled" : ""}`);
	// The manifest is never throttled: it is tiny, and delaying it only delays the dialog.
	if (!throttle) {
		createReadStream(path).pipe(res);
		return;
	}
	void sendSlowly(res, readFileSync(path), size);
});

/** Dribble the body out over SLOW_MS, so a progress bar has something to show. */
async function sendSlowly(res: ServerResponse, body: Buffer, size: number): Promise<void> {
	const STEPS = 50;
	const chunk = Math.ceil(size / STEPS);
	const gap = SLOW_MS / STEPS;
	for (let at = 0; at < size; at += chunk) {
		if (!res.write(body.subarray(at, at + chunk)))
			await new Promise((done) => res.once("drain", done));
		await new Promise((done) => setTimeout(done, gap));
	}
	res.end();
}

// A leftover server from an earlier run is the ordinary way this fails, and the default handling
// is an unhandled 'error' event: eleven lines of stack for a one-line problem, with no hint that
// the fix is to kill the old one.
server.on("error", (e) => {
	if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
	console.error(
		`error: port ${PORT} is already in use, probably by an earlier smoke run.\n` +
			`  lsof -nP -iTCP:${PORT} -sTCP:LISTEN     # check what it is\n` +
			`  kill $(lsof -tnP -iTCP:${PORT} -sTCP:LISTEN)`,
	);
	process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(`serving ${MACOS} on http://127.0.0.1:${PORT}`);
	console.log(`  installed version: ${version}`);
	console.log(`  offering:          ${offered} -> ${archive}\n`);
	if (SLOW_MS) console.log(`  throttled:         ~${SLOW_MS / 1000}s per download\n`);
	console.log("Open the app built with tauri.local-update.conf.json. Five seconds after launch");
	console.log("it should ask about " + offered + ". Requests appear below.\n");
});
