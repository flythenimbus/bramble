// Cut a release: bump a platform's manifest version, commit, tag, and push.
// Usage: bun run release <platform> <version>   e.g. bun run release chromium 1.0.0
//
// Tags as <version>-<platform> (e.g. 1.0.0-chromium). Pushing the tag triggers
// .github/workflows/release.yml, which bundles the extension and publishes
// bramble_<platform>_<version>.zip under a "<Platform> Extension <version>" release.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

// Platform name (as it appears in the release asset) -> manifest path on disk.
// "chromium" is all we ship today; add a row per target as they land.
const MANIFESTS: Record<string, string> = {
	chromium: "packages/manifests/chromium/manifest.json",
};

const fail = (msg: string): never => {
	console.error(`error: ${msg}`);
	process.exit(1);
};

const run = (cmd: string) => execSync(cmd, { stdio: "inherit" });
const capture = (cmd: string) => execSync(cmd, { encoding: "utf8" }).trim();

const [platform, rawVersion] = process.argv.slice(2);
const manifest = MANIFESTS[platform ?? ""];
if (!manifest) {
	fail(`unknown platform "${platform ?? ""}". supported: ${Object.keys(MANIFESTS).join(", ")}`);
}

// Accept either 0.1.0 or v0.1.0; the manifest stores the bare numeric version.
const version = (rawVersion ?? "").replace(/^v/, "");
if (!version)
	fail("missing version. usage: bun run release <platform> <version>  (e.g. chromium 0.1.0)");

// Chrome manifest versions: 1-4 dot-separated integers, 0-65535, no leading zeros.
const PART = /^(0|[1-9]\d{0,4})$/;
const parts = version.split(".");
if (parts.length > 4 || parts.some((p) => !PART.test(p) || Number(p) > 65535)) {
	fail(`invalid version "${version}". want 1-4 ints, each 0-65535 (e.g. 0.1.0)`);
}

const tag = `${version}-${platform}`;

// Refuse to fold unrelated edits into the release commit, or to clobber a tag.
if (capture("git status --porcelain")) fail("working tree is dirty; commit or stash first");
if (capture(`git tag -l ${tag}`)) fail(`tag ${tag} already exists`);

const before = readFileSync(manifest, "utf8");
// Targeted replace keeps the diff to one line. "manifest_version" is untouched:
// the pattern requires a quote immediately before `version`, which it lacks.
let replaced = 0;
const after = before.replace(/("version"\s*:\s*")[^"]*(")/, (_m, p1, p2) => {
	replaced++;
	return `${p1}${version}${p2}`;
});
if (replaced !== 1) fail(`expected exactly one "version" field in ${manifest}, found ${replaced}`);

const branch = capture("git rev-parse --abbrev-ref HEAD");

// When the manifest is already at this version (e.g. re-tagging after deleting
// the tag), there's nothing to bump or commit; tag the current commit as-is
// instead of failing on an empty release commit.
if (after === before) {
	console.log(`${manifest} already at ${version}; tagging current commit without a release commit`);
} else {
	writeFileSync(manifest, after);
	run(`git add ${manifest}`);
	run(`git commit -m "chore(release): ${platform} ${version}"`);
}

run(`git tag ${tag}`);
run(`git push origin ${branch}`);
run(`git push origin ${tag}`);

console.log(
	`\nreleased ${tag}: the release workflow will attach bramble_${platform}_${version}.zip`,
);
