// Cut a release entirely from your machine: bump the manifest, build + sign the
// bundle LOCALLY (the signing key never leaves this machine / your YubiKey),
// tag, push, then publish a GitHub release with the signed artifacts attached.
// Usage: pnpm run release <platform> <version>   e.g. pnpm run release chromium 1.0.0
//
// Tags as <version>-<platform> (e.g. 1.0.0-chromium). Publishing the release
// fires .github/workflows/release.yml, which only verifies the signed .crx made
// it onto the release; CI never builds or signs. Signing requires the one-time
// setup in docs/release-signing.md (age + YubiKey).

import { execSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Platform name (as it appears in the release asset) -> manifest path on disk.
// "chromium" is all we ship today; add a row per target as they land.
const MANIFESTS: Record<string, string> = {
	chromium: "packages/manifests/chromium/manifest.json",
};

const DIST = "packages/platform-extension";

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
	fail("missing version. usage: pnpm run release <platform> <version>  (e.g. chromium 0.1.0)");

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

// Gate on the same lint + tests CI enforces on main, before we touch anything,
// so a tag never ships from a red tree.
try {
	run("pnpm run ci:check");
	run("pnpm run test");
} catch {
	fail("lint or tests failed; fix them before releasing");
}

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
const bumped = after !== before;

// Bump the manifest in place (uncommitted) so the build carries the new version.
if (bumped) writeFileSync(manifest, after);

// Build + sign BEFORE we commit or tag, so a signing failure (e.g. no YubiKey)
// leaves no tag behind. wasm/ is gitignored, so rebuild it first as CI used to.
try {
	run("pnpm run wasm:build");
	run(`pnpm --filter @vault/platform-extension run bundle`);
	run("pnpm run sign");
} catch {
	fail(`build or signing failed; run \`git checkout ${manifest}\` to undo the bump`);
}

const zip = `${DIST}/bramble.zip`;
const crx = `${DIST}/bramble.crx`;
if (!existsSync(zip) || !existsSync(crx)) fail("expected bramble.zip and a signed bramble.crx");

// Commit the bump (if any), then tag and push.
if (bumped) {
	run(`git add ${manifest}`);
	run(`git commit -m "chore(release): ${platform} ${version}"`);
} else {
	console.log(`${manifest} already at ${version}; tagging current commit without a release commit`);
}
run(`git tag ${tag}`);
run(`git push origin ${branch}`);
run(`git push origin ${tag}`);

// Publish the release with the locally-signed assets. Draft -> upload -> publish
// so the `release: published` event fires only once the .crx is attached.
const title = `${platform.charAt(0).toUpperCase()}${platform.slice(1)} Extension ${version}`;
const stage = mkdtempSync(join(tmpdir(), "bramble-release-"));
const crxAsset = join(stage, `bramble_${platform}_${version}.crx`);
const zipAsset = join(stage, `bramble_${platform}_${version}.zip`);
copyFileSync(crx, crxAsset);
copyFileSync(zip, zipAsset);
try {
	run(`gh release create ${tag} --draft --generate-notes --title ${JSON.stringify(title)}`);
	run(`gh release upload ${tag} ${crxAsset} ${zipAsset}`);
	run(`gh release edit ${tag} --draft=false`);
} finally {
	rmSync(stage, { recursive: true, force: true });
}

console.log(
	`\nreleased ${tag}: signed bramble_${platform}_${version}.crx attached to the release.`,
);
