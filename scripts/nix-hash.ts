#!/usr/bin/env node
// Recompute the fetchPnpmDeps hash in the Nix derivation.
//
//   node scripts/nix-hash.ts            # rewrite package.nix if the hash moved
//   node scripts/nix-hash.ts --check    # exit 1 if it is stale, change nothing
//   node scripts/nix-hash.ts --commit   # rewrite, then commit to main (for a runner)
//
// The hash covers the whole resolved dependency store, not pnpm-lock.yaml, so it cannot be
// derived by reading a file: the only way to learn it is to perform the fetch and hash what
// lands. That is what this does, by asking for a hash that cannot be right and reading the real
// one out of the mismatch nix reports. Expect it to take as long as a cold `pnpm install`,
// because that is what it is; no binary cache can help when the hash is the unknown.
//
// Run by .github/workflows/nix-hash.yml on any change to pnpm-lock.yaml. Without it the hash
// goes stale silently: nothing else in CI builds the flake, and a stale hash is not a degraded
// build but no build at all, which is how it went unnoticed for a month in 2026.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = "packages/platform-desktop/nix/package.nix";
const HASH = /hash = "(sha256-[A-Za-z0-9+/=]+)"/;
// Any syntactically valid hash that cannot be the right one; nix reports what it got instead.
const WRONG = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const NIX = [
	"--extra-experimental-features",
	"nix-command",
	"--extra-experimental-features",
	"flakes",
];

const path = resolve(ROOT, PACKAGE);
const original = readFileSync(path, "utf8");
const declared = original.match(HASH)?.[1];
if (!declared) throw new Error(`no fetchPnpmDeps hash found in ${PACKAGE}`);

/** The hash the fetch actually produces, learned from nix's mismatch error. */
function measure(): string {
	writeFileSync(path, original.replace(HASH, `hash = "${WRONG}"`));
	try {
		execFileSync("nix", [...NIX, "build", ".#bramble.pnpmDeps", "--no-link"], {
			cwd: ROOT,
			encoding: "utf8",
			stdio: ["ignore", "ignore", "pipe"],
		});
	} catch (err) {
		const stderr = String((err as { stderr?: string }).stderr ?? "");
		const got = stderr.match(/got:\s+(sha256-[A-Za-z0-9+/=]+)/)?.[1];
		if (got) return got;
		throw new Error(`nix failed without reporting a hash:\n${stderr.slice(-2000)}`);
	} finally {
		// Whatever happened, the tree must not be left holding a hash we know is wrong.
		writeFileSync(path, original);
	}
	// A build that succeeds against WRONG would mean the mismatch check did not run.
	throw new Error("nix accepted a hash that cannot be correct; refusing to trust the result");
}

const actual = measure();
if (actual === declared) {
	console.log(`nix hash already correct: ${declared}`);
	process.exit(0);
}

if (process.argv.includes("--check")) {
	console.error(`nix hash is stale\n  declared: ${declared}\n  actual:   ${actual}`);
	console.error(`\nRun \`node scripts/nix-hash.ts\` to fix it.`);
	process.exit(1);
}

writeFileSync(path, original.replace(HASH, `hash = "${actual}"`));
console.log(`nix hash updated\n  was: ${declared}\n  now: ${actual}`);

if (process.argv.includes("--commit")) {
	const { commitFiles } = await import("./github-commit.ts");
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
	const oid = commitFiles({
		repo: "flythenimbus/bramble",
		branch: "main",
		expectedHeadOid: head,
		headline: "chore(nix): refresh the pnpm hash for the new lockfile",
		files: [PACKAGE],
	});
	console.log(`committed ${oid}`);
}
