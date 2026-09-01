// SPIKE (throwaway): will Chromium accept an explicit rp.id of "bramble.app" from a
// chrome-extension:// origin? If yes, both browsers could register under ONE rpID and a key
// made in Chrome would unlock in Firefox (Apple Passwords syncs the credential; Windows Hello
// is an OS store both browsers reach). If no, cross-browser unlock is a property to document,
// not a bug to fix. See docs/security-keys.md.
//
//   node spike-rpid.tmp.mjs        (builds, stamps, prints instructions)
//
// Delete this file, and prf-probe.* from dist-chromium, once the question is settled.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve("packages/platform-extension");
const DIR = path.join(ROOT, "dist-chromium");

const PROBE_JS = `
const VARIANTS = [
	{
		name: "explicit-rpid",
		note: "THE QUESTION: can a chrome-extension origin assert rp.id=bramble.app?",
		rpId: "bramble.app",
	},
	{
		name: "implicit-control",
		note: "CONTROL: known to work. If this fails too, the harness is broken, not the rpID.",
		rpId: null,
	},
];

const AAGUIDS = {
	"adce0002-35bc-c60a-648b-0b25f1f05503": "Chrome on Mac, internal",
	"b5397666-4885-aa6b-cebf-e52262a439a2": "Chromium Browser internal (no PRF)",
	"fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "Apple Passwords / iCloud Keychain",
	"08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello (hardware)",
};

// The passkey provider intercepts all browser WebAuthn while attached and fails an
// extension-originated request with "no resolvable tab origin". Production detaches around the
// call (src/shell.ts); a probe that skips this measures the proxy, not the authenticator.
const api = globalThis.browser ?? globalThis.chrome;
async function withProxyPaused(fn) {
	let paused = false;
	try {
		await api.runtime.sendMessage({ type: "PASSKEY_PROXY_PAUSE" });
		paused = true;
	} catch {}
	try {
		return await fn();
	} finally {
		if (paused) {
			try { await api.runtime.sendMessage({ type: "PASSKEY_PROXY_RESUME" }); } catch {}
		}
	}
}

const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const hex = (b) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
const digest = async (b) => hex(await crypto.subtle.digest("SHA-256", b));

function readAuthData(authData) {
	if (!authData) return null;
	const v = new Uint8Array(authData);
	if (v.length < 37) return null;
	const out = { userVerified: !!(v[32] & 0x04), backedUp: !!(v[32] & 0x10) };
	if (v.length >= 53) {
		const h = hex(v.slice(37, 53));
		out.aaguid = [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join("-");
		out.authenticator = AAGUIDS[out.aaguid] || "unrecognised";
	}
	return out;
}

async function run(cfg) {
	const salt = rand(32);
	const out = { variant: cfg.name, origin: location.origin, rpId: cfg.rpId || "(implicit)" };
	let created;
	try {
		created = await withProxyPaused(() => navigator.credentials.create({ publicKey: {
			challenge: rand(32),
			rp: cfg.rpId ? { name: "Bramble", id: cfg.rpId } : { name: "Bramble" },
			user: { id: rand(16), name: "spike@local", displayName: "rpID spike" },
			pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
			authenticatorSelection: {
				authenticatorAttachment: "platform",
				residentKey: "required",
				userVerification: "required",
			},
			attestation: "none",
			extensions: { prf: { eval: { first: salt } } },
		}}));
	} catch (e) {
		out.created = false;
		out.error = e.name + ": " + e.message;
		out.VERDICT = e.name === "SecurityError"
			? "REFUSED - Chromium will not assert this rpID from an extension origin. Unification is out."
			: "FAILED for another reason: " + e.name;
		return out;
	}
	out.created = true;
	out.authData = readAuthData(created.response.getAuthenticatorData?.());
	const ext = created.getClientExtensionResults();
	out.prfEnabledOnCreate = ext?.prf?.enabled ?? null;
	const atCreate = ext?.prf?.results?.first;
	out.prfSecretAtCreate = atCreate ? await digest(atCreate) : null;

	// A credential Chromium accepted but cannot then assert would be worse than a refusal.
	try {
		const got = await withProxyPaused(() => navigator.credentials.get({ publicKey: {
			challenge: rand(32),
			...(cfg.rpId ? { rpId: cfg.rpId } : {}),
			allowCredentials: [{ type: "public-key", id: created.rawId }],
			userVerification: "required",
			extensions: { prf: { eval: { first: salt } } },
		}}));
		const g = got.getClientExtensionResults()?.prf?.results?.first;
		out.prfSecretAtGet = g ? await digest(g) : null;
	} catch (e) {
		out.getError = e.name + ": " + e.message;
	}
	out.secretsMatch = out.prfSecretAtCreate && out.prfSecretAtGet
		? out.prfSecretAtCreate === out.prfSecretAtGet : null;
	out.VERDICT = out.prfSecretAtGet
		? "ACCEPTED with PRF - unification is viable, plan a migration for existing keys"
		: "created but no PRF secret - unification would not help";
	return out;
}

const KEY = "rpidspike:results";
const log = (o) => {
	const pre = document.createElement("pre");
	pre.textContent = typeof o === "string" ? o : JSON.stringify(o, null, 2);
	pre.style.cssText = "background:#111;color:#0f0;padding:8px;overflow:auto;font:12px monospace";
	document.getElementById("out").prepend(pre);
	console.log(o);
};

(async () => {
	const bar = document.getElementById("bar");
	log({ browser: navigator.userAgent, origin: location.origin });
	const prior = (await api.storage.local.get(KEY))[KEY] || [];
	if (prior.length) { log("--- recovered from storage ---"); for (const p of prior) log(p); }
	for (const v of VARIANTS) {
		const b = document.createElement("button");
		b.textContent = v.name;
		b.title = v.note;
		b.style.cssText = "margin:4px;padding:8px";
		b.onclick = async () => {
			b.disabled = true;
			log("running " + v.name + " ... " + v.note);
			const r = await run(v).catch((e) => ({ variant: v.name, harnessError: String(e) }));
			const cur = (await api.storage.local.get(KEY))[KEY] || [];
			cur.push(r);
			await api.storage.local.set({ [KEY]: cur });
			log(r);
			b.disabled = false;
		};
		bar.append(b);
	}
})();
`;

const PROBE_HTML = `<!DOCTYPE html>
<html>
	<head><meta charset="utf-8" /><title>rpID spike</title></head>
	<body style="font:14px system-ui;margin:16px">
		<h3>Can Chromium assert rp.id=bramble.app from an extension origin?</h3>
		<p>Run <b>explicit-rpid</b> first. An instant SecurityError is the expected "no".
		If a dialog appears, pick <b>iCloud Keychain / Apple Passwords</b>.</p>
		<p>Run <b>implicit-control</b> only if the first one fails, to prove the harness works.</p>
		<div id="bar"></div>
		<div id="out"></div>
		<script src="./prf-probe.js"></script>
	</body>
</html>
`;

if (!process.argv.includes("--no-build")) {
	console.log("building chromium ...");
	execFileSync("pnpm", ["--filter", "@vault/platform-extension", "build:chromium"], {
		stdio: ["ignore", "ignore", "inherit"],
	});
}
if (!existsSync(DIR)) {
	console.error(`missing ${DIR}`);
	process.exit(1);
}
const manifest = JSON.parse(await readFile(path.join(DIR, "manifest.json"), "utf8"));
if (!manifest.key) {
	console.error("dist-chromium/manifest.json has no `key`; rebuild so the rpID under test is real.");
	process.exit(1);
}
const sha = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex");
const id = [...sha.slice(0, 32)].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join("");

writeFileSync(path.join(DIR, "prf-probe.html"), PROBE_HTML);
writeFileSync(path.join(DIR, "prf-probe.js"), PROBE_JS);
manifest.action.default_popup = "prf-probe.html";
writeFileSync(path.join(DIR, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);

console.log(`stamped. the toolbar popup now opens the probe (the next build restores it)

  1. reload the extension at brave://extensions (or vivaldi://extensions)
  2. click the Bramble toolbar icon
  3. click "explicit-rpid"

Expected "no" is an instant SecurityError. Anything else is the interesting answer.
Extension id / implicit rpID: ${id}`);
