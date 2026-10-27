#!/usr/bin/env node
// Delete the build-artifact folders that grow without bound: the core's Rust target, the desktop's
// Tauri target, and iOS DerivedData (about 54 GB together by October 2026). Each regenerates on its
// next build, which starts from scratch.
//
// Agent worktrees under .claude/worktrees go too when they are clean and everything in them is on
// main; each carries its own node_modules (about 1 GB, 18 GB for eleven of them).
//
// The desktop's release/bundle stays. The app may be running from bundle/macos/Bramble.app, and the
// browsers' native-messaging manifests point at the bramble-proxy inside it, so removing it would
// break the extension's link to the desktop app.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, rmSync, statfsSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKTREES = ".claude/worktrees";
const BRANCH_PREFIX = "worktree-";
const MAIN = "main";

/** Delete the artifact folders under `root`, keeping the desktop bundle; returns what was removed. */
export function nukeArtifacts(root: string): string[] {
	const removed: string[] = [];
	const remove = (path: string): void => {
		if (!existsSync(path)) return;
		rmSync(path, { recursive: true, force: true });
		removed.push(path);
	};

	remove(join(root, "packages/core-rust/target"));
	remove(join(root, "clients/mobile/ios/DerivedData"));

	const target = join(root, "clients/desktop/src-tauri/target");
	if (existsSync(target)) {
		for (const entry of readdirSync(target)) {
			if (entry !== "release") remove(join(target, entry));
		}
		const release = join(target, "release");
		if (existsSync(release)) {
			for (const entry of readdirSync(release)) {
				if (entry !== "bundle") remove(join(release, entry));
			}
		}
	}
	return removed;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function listWorktrees(root: string): { path: string; branch: string | null }[] {
	return git(root, "worktree", "list", "--porcelain")
		.split("\n\n")
		.filter(Boolean)
		.map((block) => {
			const lines = block.split("\n");
			const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length) ?? "";
			const ref = lines.find((l) => l.startsWith("branch "))?.slice("branch ".length) ?? null;
			return { path, branch: ref?.replace("refs/heads/", "") ?? null };
		});
}

/** Why this worktree must stay, or null when its commits are all on main. */
function whyKept(path: string, here: string): string | null {
	if (here === path || here.startsWith(path + sep)) return "in use here";
	// cherry compares by patch, so a commit that main took by cherry-pick or squash counts as there.
	const ahead = git(path, "cherry", MAIN)
		.split("\n")
		.some((l) => l.startsWith("+"));
	return ahead ? `commits not on ${MAIN}` : null;
}

export interface PruneResult {
	removed: string[];
	kept: { name: string; reason: string }[];
}

/** Remove the worktrees under `root` whose work is all on main, and their `worktree-*` branches. */
export function pruneWorktrees(root: string, cwd: string = process.cwd()): PruneResult {
	const result: PruneResult = { removed: [], kept: [] };
	const dir = join(root, WORKTREES);
	if (!existsSync(dir)) return result;
	const base = realpathSync(dir);
	const here = realpathSync(cwd);

	for (const { path, branch } of listWorktrees(root)) {
		if (dirname(path) !== base) continue;
		const name = basename(path);
		let reason: string | null;
		try {
			reason = whyKept(path, here);
			// No --force: git itself refuses a worktree with uncommitted changes.
			if (!reason) git(root, "worktree", "remove", path);
		} catch (e) {
			reason = e instanceof Error ? (e.message.trim().split("\n").at(-1) ?? e.message) : String(e);
		}
		if (reason) {
			result.kept.push({ name, reason });
			continue;
		}
		result.removed.push(name);
		if (branch?.startsWith(BRANCH_PREFIX)) git(root, "branch", "-D", branch);
	}
	return result;
}

/** A build writing into these folders right now, if any. */
function runningBuild(): string | null {
	if (process.platform === "win32") return null;
	const procs = execFileSync("ps", ["-axo", "comm"], { encoding: "utf8" });
	const hit = procs.split("\n").find((p) => /(^|\/)(cargo|rustc|xcodebuild|gradle)/i.test(p));
	return hit ? hit.trim() : null;
}

function freeBytes(): number {
	const s = statfsSync(ROOT);
	return s.bavail * s.bsize;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const build = runningBuild();
	if (build && !process.argv.includes("--force")) {
		console.error(`A build is running (${build}); not deleting under it. Rerun with --force.`);
		process.exit(1);
	}
	const before = freeBytes();
	const removed = nukeArtifacts(ROOT);
	const pruned = pruneWorktrees(ROOT);
	for (const path of removed) console.log(`removed ${path.slice(ROOT.length + 1)}`);
	for (const name of pruned.removed) console.log(`removed ${WORKTREES}/${name}`);
	for (const { name, reason } of pruned.kept) console.log(`kept ${WORKTREES}/${name} (${reason})`);
	const freed = (freeBytes() - before) / 1024 ** 3;
	console.log(
		removed.length || pruned.removed.length ? `freed ${freed.toFixed(1)} GB` : "nothing to remove",
	);
}
