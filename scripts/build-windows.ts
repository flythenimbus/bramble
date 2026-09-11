#!/usr/bin/env node
// The Windows installer, by either of the two routes it can be built.
//
// Usage:
//   pnpm run build:windows --unsigned   cross-compiled here, throwaway key, for iterating
//   pnpm run build:windows --arm64      the other architecture, cross-compiled
//   pnpm run build:windows --ci-start   dispatch the GitHub build + SignPath signing, do not wait
//   pnpm run build:windows --ci-collect wait for it, download the signed installer, sign it here
//
// Two routes because the release build and the iteration build want opposite things.
//
// **Iterating** wants the loop short, so it cross-compiles from this machine with cargo-xwin.
// Tauri supports that and calls it a last resort; it is fine for something that is going into a
// VM and nowhere else. It cannot be Authenticode-signed.
//
// **Releasing** cannot use that route at all, and the reason is not technical quality but
// provenance: SignPath's free tier for open source projects verifies where a binary came from,
// and requires every job up to the signing request to have run on a GitHub-hosted agent, with the
// origin metadata supplied by GitHub rather than by the build. So a release installer is built by
// .github/workflows/sign-windows.yml and signed there. Windows is the only artifact Bramble ships
// that is not built on the maintainer's machine. See docs/desktop-port.md.
//
// The updater key does not follow it into CI. That key is the root of trust for every update the
// app will ever accept, so the .sig is generated HERE, over the Authenticode-signed bytes that
// come back. Order matters: Authenticode first, updater signature second. Reversed, the .sig
// describes a file that no longer exists and every Windows update fails.

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { signingKey } from "./desktop-signing-key.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONF = "packages/platform-desktop/src-tauri/tauri.conf.json";
const WORKFLOW = "sign-windows.yml";

const fail = (message: string): never => {
	console.error(message);
	process.exit(1);
};

const argv = process.argv.slice(2);
const unsigned = argv.includes("--unsigned");
const ciStart = argv.includes("--ci-start");
const ciCollect = argv.includes("--ci-collect");
const triple = argv.includes("--arm64") ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
const forwarded = argv.filter(
	(a) => !["--unsigned", "--arm64", "--ci-start", "--ci-collect"].includes(a),
);

/** Where both routes put the installer, so everything downstream reads one path. */
const BUNDLE = join("packages/platform-desktop/src-tauri/target", triple, "release/bundle/nsis");
/** The dispatched run, handed from --ci-start to --ci-collect. */
const RUN_ID_FILE = join(ROOT, "packages/platform-desktop/src-tauri/target/.windows-signing-run");

const has = (bin: string): boolean => {
	try {
		execFileSync("which", [bin], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

const capture = (cmd: string, args: string[]): string =>
	execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8" }).trim();

const version = (): string => JSON.parse(readFileSync(join(ROOT, CONF), "utf8")).version;

// ----- the CI route: build and Authenticode-sign on GitHub, updater-sign here -----

/**
 * Dispatch the workflow and record which run it started.
 *
 * The run id is written to a file rather than returned, because a release kicks this off and then
 * spends several minutes notarizing macOS before it comes back for the result. Finding the run by
 * "most recent" at that point could pick up a rerun somebody triggered by hand in between.
 */
function ciStartBuild(): void {
	if (!has("gh")) fail("build-windows: the GitHub CLI is required for --ci-start. brew install gh");

	// CI builds a PUSHED commit, so anything still local means it would build the previous
	// version, Authenticode-sign it, and hand back an installer that looks right.
	if (capture("git", ["status", "--porcelain"]))
		fail("build-windows: working tree is dirty; CI would build a different tree than this one");
	const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
	const local = capture("git", ["rev-parse", "HEAD"]);
	const remote = capture("git", ["rev-parse", `origin/${branch}`]);
	if (local !== remote)
		fail(
			`build-windows: HEAD is not pushed (${local.slice(0, 8)} vs origin/${branch} ` +
				`${remote.slice(0, 8)}).\nCI can only build what it can fetch.`,
		);

	// A workflow is only dispatchable once it exists on the remote default branch, and `gh` reports
	// that as a bare "could not find any workflows named ..." which reads like a typo rather than
	// an unpushed file. Worth its own message: pushing .github/ needs a token scope the release
	// does not otherwise use, so this is a genuine first-time stumble.
	if (!capture("gh", ["workflow", "list", "--all"]).includes(WORKFLOW))
		fail(
			`build-windows: GitHub does not know about ${WORKFLOW} yet.\n` +
				"  Push .github/workflows/ to the default branch first; a workflow cannot be\n" +
				"  dispatched until it exists there.",
		);

	const v = version();
	// Recorded before dispatching. A run created before this instant is somebody else's.
	const since = new Date(Date.now() - 5_000).toISOString();
	console.log(`build-windows: dispatching ${WORKFLOW} for ${v} on ${branch}…`);
	execFileSync("gh", ["workflow", "run", WORKFLOW, "-f", `version=${v}`, "--ref", branch], {
		cwd: ROOT,
		stdio: "inherit",
	});

	// `gh workflow run` returns before the run exists, so this polls for it rather than assuming.
	let runId = "";
	for (let attempt = 0; attempt < 30 && !runId; attempt++) {
		const runs = JSON.parse(
			capture("gh", [
				"run",
				"list",
				"--workflow",
				WORKFLOW,
				"--event",
				"workflow_dispatch",
				"--json",
				"databaseId,createdAt",
				"--limit",
				"20",
			]),
		) as { databaseId: number; createdAt: string }[];
		const mine = runs
			.filter((r) => r.createdAt >= since)
			.sort((a, b) => b.databaseId - a.databaseId);
		if (mine[0]) runId = String(mine[0].databaseId);
		// Synchronous on purpose: everything here is sequential, and one shared buffer beats
		// spawning a `sleep` thirty times.
		else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
	}
	if (!runId) fail(`build-windows: dispatched ${WORKFLOW} but no run appeared; check GitHub`);

	mkdirSync(dirname(RUN_ID_FILE), { recursive: true });
	writeFileSync(RUN_ID_FILE, `${runId}\n`);
	console.log(
		`build-windows: run ${runId} started.\n` +
			"  It will WAIT for you to approve the signing request in SignPath.\n" +
			`  https://github.com/flythenimbus/bramble/actions/runs/${runId}`,
	);
}

/** Wait for the dispatched run, bring the signed installer back, and sign it for the updater. */
function ciCollectBuild(): void {
	if (!has("gh")) fail("build-windows: the GitHub CLI is required for --ci-collect");
	if (!existsSync(RUN_ID_FILE))
		fail("build-windows: no dispatched run recorded; run --ci-start first");
	const runId = readFileSync(RUN_ID_FILE, "utf8").trim();

	console.log(`build-windows: waiting on run ${runId} (approve the signing request in SignPath)…`);
	try {
		execFileSync("gh", ["run", "watch", runId, "--exit-status"], { cwd: ROOT, stdio: "inherit" });
	} catch {
		fail(
			`build-windows: run ${runId} did not succeed.\n` +
				`  https://github.com/flythenimbus/bramble/actions/runs/${runId}`,
		);
	}

	// Into the same directory the cross-compiled build writes, so release.ts and
	// release-desktop.mjs read one path whichever route produced the installer.
	const dest = join(ROOT, BUNDLE);
	mkdirSync(dest, { recursive: true });
	// Cleared first: a stale cross-compiled installer here is unsigned, and publishing it instead
	// would be invisible until a user hit SmartScreen.
	for (const f of readdirSync(dest)) rmSync(join(dest, f), { force: true });

	execFileSync("gh", ["run", "download", runId, "-n", "bramble-windows-signed", "-D", dest], {
		cwd: ROOT,
		stdio: "inherit",
	});

	const exes = readdirSync(dest).filter((f) => f.endsWith("-setup.exe"));
	if (exes.length !== 1)
		fail(`build-windows: expected one -setup.exe in ${BUNDLE}, found ${exes.length}`);
	const installer = join(dest, exes[0] as string);

	const v = version();
	if (!exes[0]?.includes(v))
		fail(`build-windows: ${exes[0]} is not version ${v}; the workflow built the wrong commit`);

	// The workflow builds with a throwaway key because the bundler will not emit updater artifacts
	// without one. That .sig is over the pre-Authenticode bytes and signed with a key no installed
	// app trusts, so it must not survive into a release.
	const stale = `${installer}.sig`;
	if (existsSync(stale)) rmSync(stale);

	const key = signingKey(fail);
	if (!key)
		fail(
			"build-windows: no updater signing key. Set TAURI_SIGNING_PRIVATE_KEY or plug in the YubiKey.",
		);

	console.log("build-windows: signing the Authenticode-signed installer for the updater…");
	execFileSync(
		"pnpm",
		["--filter", "@vault/platform-desktop", "exec", "tauri", "signer", "sign", installer],
		{
			cwd: ROOT,
			stdio: "inherit",
			env: {
				...process.env,
				TAURI_SIGNING_PRIVATE_KEY: key,
				TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
			},
		},
	);
	if (!existsSync(stale)) fail(`build-windows: ${exes[0]}.sig was not written`);
	rmSync(RUN_ID_FILE, { force: true });
	console.log(`\nbuild-windows: signed installer in ${BUNDLE}`);
}

// ----- the local route: cross-compiled, for iterating -----

/**
 * The cross toolchain, checked up front.
 *
 * Each of these fails deep inside a build that has already run for minutes, with an error naming
 * a C header or a linker rather than the thing that is actually missing.
 */
function checkToolchain(): void {
	const missing: string[] = [];
	if (!has("cargo-xwin")) missing.push("cargo install --locked cargo-xwin");
	// clang-cl compiles the C in ring and friends; lld-link is what it links with. Homebrew
	// splits them across two formulae, and llvm alone leaves lld-link absent.
	if (!has("clang-cl")) missing.push("brew install llvm  (then add its bin to PATH)");
	if (!has("lld-link")) missing.push("brew install lld   (then add its bin to PATH)");
	if (!has("makensis")) missing.push("brew install nsis");

	const installed = capture("rustup", ["target", "list", "--installed"]);
	if (!installed.includes(triple)) missing.push(`rustup target add ${triple}`);

	if (missing.length > 0)
		fail(`build-windows: missing cross toolchain. Run:\n  ${missing.join("\n  ")}`);
}

/** A key for this build only, so iterating does not wait on a YubiKey touch. */
function throwawayKey(): string {
	const tmp = mkdtempSync(join(tmpdir(), "bramble-windows-key-"));
	try {
		const path = join(tmp, "throwaway.key");
		execFileSync(
			"pnpm",
			[
				"--filter",
				"@vault/platform-desktop",
				"exec",
				"tauri",
				"signer",
				"generate",
				"-w",
				path,
				"-p",
				"",
			],
			{ cwd: ROOT, stdio: "ignore" },
		);
		return readFileSync(path, "utf8");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

function crossBuild(): void {
	// Before the toolchain check, so someone who meant to cut a release is told that rather than
	// being sent to install a compiler they do not need.
	if (!unsigned)
		fail(
			"build-windows: a cross-compiled installer cannot be Authenticode-signed, so it must not\n" +
				"be released. Use --unsigned to build one for testing, or --ci-start/--ci-collect\n" +
				"for a release. See docs/desktop-port.md.",
		);
	checkToolchain();

	execFileSync(
		"pnpm",
		[
			"--filter",
			"@vault/platform-desktop",
			"exec",
			"tauri",
			"build",
			"--runner",
			"cargo-xwin",
			"--target",
			triple,
			"--bundles",
			"nsis",
			...forwarded,
		],
		{
			cwd: ROOT,
			stdio: "inherit",
			env: {
				...process.env,
				// Read by stage-proxy, which runs as Tauri's beforeBuildCommand and is given no
				// arguments of its own. Without it the host's proxy ships as a Mach-O named .exe.
				BRAMBLE_TARGET: triple,
				TAURI_SIGNING_PRIVATE_KEY: throwawayKey(),
				TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
			},
		},
	);

	console.log(`\nbuild-windows: installer in ${BUNDLE}`);
	console.log(
		"NOT Authenticode-signed and signed with a THROWAWAY updater key: for a VM, not for anyone else.",
	);
}

if (ciStart) ciStartBuild();
else if (ciCollect) ciCollectBuild();
else crossBuild();
