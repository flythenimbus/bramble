#!/usr/bin/env node
// Sign dist-linux/rpm/*.rpm in place with the APT repository's key, then check each one against
// the shipped keyring. Run by desktop-release.yml. See docs/apt-releases.md, "RPMs".

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { importEnvGpgKey } from "./gpg-env-key.ts";
import { hasGoodSignature, rpmSignArgs } from "./rpm-signing.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RPMS = join(ROOT, "dist-linux/rpm");
const keyring = join(ROOT, "clients/desktop/apt/bramble-keyring.asc");

const fail = (message: string): never => {
	console.error(message);
	process.exit(1);
};

const gpgKey = process.env.BRAMBLE_APT_GPG_KEY ?? fail("BRAMBLE_APT_GPG_KEY is not set.");
const passphraseFile = importEnvGpgKey(gpgKey) ?? fail("APT_GPG_PRIVATE_KEY is not set.");
const gpg = execFileSync("which", ["gpg"], { encoding: "utf8" }).trim();

const packages = existsSync(RPMS) ? readdirSync(RPMS).filter((f) => f.endsWith(".rpm")) : [];
if (packages.length === 0) fail(`no .rpm in ${RPMS}`);

const db = mkdtempSync(join(tmpdir(), "bramble-rpmdb-"));
process.on("exit", () => rmSync(db, { recursive: true, force: true }));
execFileSync("rpmkeys", ["--dbpath", db, "--import", keyring], { stdio: "inherit" });

for (const name of packages) {
	const file = join(RPMS, name);
	execFileSync("rpmsign", rpmSignArgs({ gpg, gpgKey, passphraseFile, file }), { stdio: "inherit" });
	const check = spawnSync("rpmkeys", ["--dbpath", db, "--checksig", file], { encoding: "utf8" });
	if (check.status !== 0 || !hasGoodSignature(check.stdout))
		fail(`${name} does not verify against ${keyring}:\n${check.stdout}${check.stderr}`);
	console.log(check.stdout.trim());
}
