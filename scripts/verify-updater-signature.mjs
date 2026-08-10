#!/usr/bin/env node
// Verify an updater archive against the public key compiled into the app.
//
// This is the check that matters on a desktop release: installed apps accept an update only if it
// verifies against the key baked into THEM, so an archive signed with the wrong key — or not
// signed at all — produces a release that looks complete and updates nobody. The failure is
// invisible from the publishing side, which is why it is worth asserting rather than assuming.
//
// Reimplemented rather than shelling out to minisign so CI needs no extra package and the check
// can be run anywhere. Tauri emits base64-wrapped minisign: the .sig file is a whole minisign
// signature file, base64'd again.
//
// Usage: node scripts/verify-updater-signature.mjs <archive> <archive.sig> [--pubkey <file>]

import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

const CONF = "packages/platform-desktop/src-tauri/tauri.conf.json";

const args = process.argv.slice(2);
const pubkeyAt = args.indexOf("--pubkey");
const pubkeyFile = pubkeyAt === -1 ? null : args[pubkeyAt + 1];
const [archivePath, sigPath] = args.filter(
  (a, i) => !a.startsWith("--") && i !== (pubkeyAt === -1 ? -1 : pubkeyAt + 1),
);

const fail = (message) => {
  console.error(`error: ${message}`);
  process.exit(1);
};

if (!archivePath || !sigPath)
  fail("usage: verify-updater-signature.mjs <archive> <archive.sig> [--pubkey <file>]");

/** The second line of a minisign key/signature file, decoded. */
function payload(text, what) {
  const line = text.split("\n").filter((l) => l && !l.startsWith("untrusted comment:"))[0];
  if (!line) fail(`${what} has no payload line`);
  return Buffer.from(line.trim(), "base64");
}

/** Tauri stores keys base64'd a second time; accept either wrapping. */
function unwrap(text) {
  const trimmed = text.trim();
  return trimmed.startsWith("untrusted comment:")
    ? trimmed
    : Buffer.from(trimmed, "base64").toString("utf8");
}

// The public key as the app has it: from tauri.conf.json, so this verifies against exactly what
// was compiled in rather than against whichever key happened to do the signing.
const pubRaw = pubkeyFile
  ? readFileSync(pubkeyFile, "utf8")
  : JSON.parse(readFileSync(CONF, "utf8")).plugins.updater.pubkey;

const pub = payload(unwrap(pubRaw), "public key");
// 2-byte algorithm, 8-byte key id, 32-byte Ed25519 key.
if (pub.length !== 42) fail(`public key is ${pub.length} bytes, want 42`);
const pubKeyId = pub.subarray(2, 10);
const pubKey = pub.subarray(10);

// Tauri writes the .sig base64'd a second time; tolerate a raw one too, so a hand-made file works.
const sig = payload(unwrap(readFileSync(sigPath, "utf8")), "signature");
if (sig.length !== 74) fail(`signature is ${sig.length} bytes, want 74`);
const alg = sig.subarray(0, 2).toString("utf8");
const sigKeyId = sig.subarray(2, 10);
const signature = sig.subarray(10);

// A signature from a different key is the exact thing this exists to catch, and it is worth
// naming separately from "does not verify" — one means the wrong key was used, the other means
// the bytes changed.
if (!pubKeyId.equals(sigKeyId))
  fail(
    `signed with key ${sigKeyId.toString("hex")}, but the app trusts ${pubKeyId.toString("hex")}.\n` +
      "That archive would be rejected by every installed app.",
  );

const archive = readFileSync(archivePath);
// "ED" is minisign's prehashed mode (Blake2b-512 of the file); "Ed" signs the file directly.
if (alg !== "ED" && alg !== "Ed") fail(`unknown signature algorithm "${alg}"`);
const message = alg === "ED" ? createHash("blake2b512").update(archive).digest() : archive;

// Raw Ed25519 keys are not a format Node reads, so wrap in the fixed SPKI prefix for Ed25519.
const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pubKey]);
const key = createPublicKey({ key: spki, format: "der", type: "spki" });

if (!verify(null, message, key, signature)) fail(`${archivePath} does NOT verify against the key`);

console.log(`ok: ${archivePath} verifies against key ${pubKeyId.toString("hex")}`);
