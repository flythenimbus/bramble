// node --test scripts/nuke-artifacts.test.ts
//
// Runs against a scratch tree laid out like the repo, so what is deleted and what is kept is
// checked on real directories.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { nukeArtifacts, pruneWorktrees } from "./nuke-artifacts.ts";

let root: string;

function touch(path: string): void {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), "x");
}

const TARGET = "clients/desktop/src-tauri/target";
const PROXY = `${TARGET}/release/bundle/macos/Bramble.app/Contents/MacOS/bramble-proxy`;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "nuke-artifacts-"));
	touch("packages/core-rust/target/debug/libvault.rlib");
	touch("clients/mobile/ios/DerivedData/Build/Products/App.app/App");
	touch(`${TARGET}/debug/bramble-desktop`);
	touch(`${TARGET}/x86_64-pc-windows-msvc/release/bramble-desktop.exe`);
	touch(`${TARGET}/release/deps/libtauri.rlib`);
	touch(`${TARGET}/release/bramble-desktop`);
	touch(PROXY);
	touch(`${TARGET}/release/bundle/dmg/Bramble.dmg`);
	// Neighbours that must survive.
	touch("desktop-updater-key.backup.age");
	touch("clients/mobile/ios/App/VaultCryptoFFI/VaultCrypto.xcframework/Info.plist");
	touch("packages/core-rust/src/lib.rs");
});

describe("nukeArtifacts", () => {
	it("deletes the Rust target, iOS DerivedData, and the desktop build tree", () => {
		nukeArtifacts(root);

		assert.equal(existsSync(join(root, "packages/core-rust/target")), false);
		assert.equal(existsSync(join(root, "clients/mobile/ios/DerivedData")), false);
		assert.equal(existsSync(join(root, `${TARGET}/debug`)), false);
		assert.equal(existsSync(join(root, `${TARGET}/x86_64-pc-windows-msvc`)), false);
		assert.equal(existsSync(join(root, `${TARGET}/release/deps`)), false);
		assert.equal(existsSync(join(root, `${TARGET}/release/bramble-desktop`)), false);
	});

	it("keeps the desktop app bundle the browsers' native-messaging host points into", () => {
		nukeArtifacts(root);

		assert.equal(existsSync(join(root, PROXY)), true);
		assert.equal(existsSync(join(root, `${TARGET}/release/bundle/dmg/Bramble.dmg`)), true);
	});

	it("touches nothing else", () => {
		nukeArtifacts(root);

		assert.equal(existsSync(join(root, "desktop-updater-key.backup.age")), true);
		assert.equal(
			existsSync(
				join(root, "clients/mobile/ios/App/VaultCryptoFFI/VaultCrypto.xcframework/Info.plist"),
			),
			true,
		);
		assert.equal(existsSync(join(root, "packages/core-rust/src/lib.rs")), true);
	});

	it("reports what it removed, and is a no-op when there is nothing to remove", () => {
		const first = nukeArtifacts(root);
		assert.ok(first.includes(join(root, "packages/core-rust/target")));
		assert.ok(first.includes(join(root, `${TARGET}/debug`)));

		assert.deepEqual(nukeArtifacts(root), []);
	});
});

function git(cwd: string, ...args: string[]): string {
	const identity = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
	return execFileSync("git", [...identity, ...args], { cwd, encoding: "utf8" });
}

describe("pruneWorktrees", () => {
	const dir = (name: string) => join(root, ".claude/worktrees", name);

	function addWorktree(name: string, branch = `worktree-${name}`): string {
		git(root, "worktree", "add", "-q", "-b", branch, dir(name));
		return dir(name);
	}

	function commitIn(cwd: string, file: string): string {
		writeFileSync(join(cwd, file), file);
		git(cwd, "add", file);
		git(cwd, "commit", "-q", "-m", file);
		return git(cwd, "rev-parse", "HEAD").trim();
	}

	function branches(): string[] {
		return git(root, "branch", "--format=%(refname:short)").split("\n").filter(Boolean);
	}

	beforeEach(() => {
		git(root, "init", "-q", "-b", "main");
		writeFileSync(join(root, ".gitignore"), "node_modules/\n");
		writeFileSync(join(root, "README"), "x");
		git(root, "add", ".gitignore", "README");
		git(root, "commit", "-q", "-m", "init");
	});

	it("removes a clean worktree and its branch", () => {
		const path = addWorktree("idle");

		const { removed, kept } = pruneWorktrees(root);

		assert.deepEqual(removed, ["idle"]);
		assert.deepEqual(kept, []);
		assert.equal(existsSync(path), false);
		assert.deepEqual(branches(), ["main"]);
	});

	it("removes a worktree whose commit main has under another hash", () => {
		const path = addWorktree("landed");
		const sha = commitIn(path, "feature");
		commitIn(root, "other");
		git(root, "cherry-pick", sha);

		assert.deepEqual(pruneWorktrees(root).removed, ["landed"]);
	});

	it("removes a worktree whose only extra files are ignored", () => {
		const path = addWorktree("built");
		mkdirSync(join(path, "node_modules/dep"), { recursive: true });
		writeFileSync(join(path, "node_modules/dep/index.js"), "x");

		assert.deepEqual(pruneWorktrees(root).removed, ["built"]);
		assert.equal(existsSync(path), false);
	});

	it("keeps a worktree with a commit main does not have", () => {
		const path = addWorktree("ahead");
		commitIn(path, "feature");

		const { removed, kept } = pruneWorktrees(root);

		assert.deepEqual(removed, []);
		assert.deepEqual(
			kept.map((k) => k.name),
			["ahead"],
		);
		assert.equal(existsSync(path), true);
		assert.ok(branches().includes("worktree-ahead"));
	});

	it("keeps a worktree with uncommitted changes", () => {
		const path = addWorktree("dirty");
		writeFileSync(join(path, "README"), "edited");

		assert.deepEqual(pruneWorktrees(root).removed, []);
		assert.equal(existsSync(path), true);
	});

	it("keeps a worktree with an untracked file", () => {
		const path = addWorktree("scratch");
		writeFileSync(join(path, "notes.tmp"), "x");

		assert.deepEqual(pruneWorktrees(root).removed, []);
		assert.equal(existsSync(path), true);
	});

	it("keeps the worktree it is run from", () => {
		const path = addWorktree("here");
		mkdirSync(join(path, "sub"));

		const { removed, kept } = pruneWorktrees(root, join(path, "sub"));

		assert.deepEqual(removed, []);
		assert.deepEqual(
			kept.map((k) => k.name),
			["here"],
		);
	});

	it("keeps a branch it did not make for the worktree", () => {
		addWorktree("mine", "feat-x");

		assert.deepEqual(pruneWorktrees(root).removed, ["mine"]);
		assert.ok(branches().includes("feat-x"));
	});

	it("does nothing without a worktrees folder", () => {
		assert.deepEqual(pruneWorktrees(root), { removed: [], kept: [] });
	});
});
