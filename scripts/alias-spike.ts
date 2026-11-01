/**
 * Phase 0 spike for email alias providers (issue #74, docs/email-aliases.md).
 *
 * Answers the questions a design doc cannot: whether the ACTUAL responses carry the CORS header
 * the preflight promised, what each provider's discovery endpoint really returns for the account
 * in hand, and what a create looks like on the wire. Everything here is throwaway; nothing in it
 * is the shape the real client should take.
 *
 * Read-only unless --create is passed. A create is a real alias on a real account against real
 * quota, so it is not something a spike does by accident.
 *
 * Tokens come from the environment (put them in .env.local, which is gitignored):
 *
 *   ADDY_API_KEY, ADDY_BASE_URL (default https://app.addy.io)
 *   SIMPLELOGIN_API_KEY, SIMPLELOGIN_BASE_URL (default https://app.simplelogin.io)
 *   FASTMAIL_API_TOKEN
 *   FORWARDEMAIL_API_KEY, FORWARDEMAIL_DOMAIN (defaults to the first domain on the account)
 *   RELAY_API_KEY          (relay.firefox.com, from the account settings page)
 *   DUCKDUCKGO_API_TOKEN   (no key page exists; read it out of devtools, see docs/email-aliases.md)
 *
 * Usage:
 *   pnpm run spike:aliases              # verify tokens + discovery, no writes
 *   pnpm run spike:aliases --create     # also create ONE alias per configured provider
 *   pnpm run spike:aliases --create --only=forwardemail   # just one, since a create is not free
 */

// The origins the four targets actually run at. The question is not whether these hosts do CORS
// in general but whether they do it for the exact opaque origins our apps present.
const ORIGINS = {
	extension: "chrome-extension://cjjaeoklmfphpjbmoeejlbjjjhilomnk",
	desktop: "tauri://localhost",
	ios: "capacitor://localhost",
	android: "https://localhost",
} as const;

const CREATE = process.argv.includes("--create");
// Whatever site the fake signup is pretending to be. Shows up in the provider's dashboard, so it
// is obviously a test rather than something the user has to puzzle over later.
const FOR_DOMAIN = "bramble-spike.example.com";
const DESCRIPTION = "Bramble Phase 0 spike (safe to delete)";

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

interface Called {
	status: number;
	acao: string | null;
	body: unknown;
	raw: string;
}

/**
 * One request, reported the way the spike needs it: status, the CORS header the browser would
 * enforce, and the parsed body. `origin` is sent explicitly because node has no origin of its own,
 * and reflecting-vs-wildcard is the entire question for two of the three providers.
 */
async function call(
	label: string,
	url: string,
	init: RequestInit & { origin?: string } = {},
): Promise<Called> {
	const { origin = ORIGINS.extension, headers, ...rest } = init;
	let res: Response;
	try {
		res = await fetch(url, {
			...rest,
			// Never ambient cookies: the token is the only credential, deliberately. See
			// docs/email-aliases.md and 1255ab7b.
			credentials: "omit",
			// A redirect out of an API call means the session was rejected, and its destination is
			// an HTML login page with no CORS. Following it turns "bad key" into an opaque failure.
			redirect: "manual",
			headers: { ...(headers as Record<string, string>), Origin: origin },
		});
	} catch (e) {
		console.log(`  ${red("x")} ${label}: ${(e as Error).message}`);
		return { status: 0, acao: null, body: undefined, raw: "" };
	}
	const raw = await res.text();
	let body: unknown;
	try {
		body = JSON.parse(raw);
	} catch {
		body = undefined;
	}
	const acao = res.headers.get("access-control-allow-origin");
	const ok = res.status >= 200 && res.status < 300;
	const cors = acao ? green(acao) : red("no ACAO header");
	console.log(
		`  ${ok ? green("ok") : red(String(res.status))} ${label} ${dim(`[${origin} -> ${cors}]`)}`,
	);
	if (!ok) console.log(dim(`     ${raw.slice(0, 300)}`));
	return { status: res.status, acao, body, raw };
}

/** Whether every app origin gets an ACAO back from the real endpoint, not just the preflight. */
async function corsMatrix(label: string, url: string, headers: Record<string, string>) {
	console.log(dim(`  cors matrix (${label}):`));
	for (const [name, origin] of Object.entries(ORIGINS)) {
		const res = await fetch(url, { headers: { ...headers, Origin: origin } }).catch(() => null);
		const acao = res?.headers.get("access-control-allow-origin") ?? null;
		const verdict = acao === "*" || acao === origin ? green(acao) : red(acao ?? "none");
		console.log(`    ${name.padEnd(10)} ${origin.padEnd(46)} ${verdict}`);
	}
}

const pick = (o: unknown, path: string): unknown =>
	path.split(".").reduce<unknown>((v, k) => (v as Record<string, unknown>)?.[k], o);

async function addy() {
	const key = process.env.ADDY_API_KEY;
	const base = (process.env.ADDY_BASE_URL ?? "https://app.addy.io").replace(/\/$/, "");
	if (!key) return console.log(dim("\naddy.io: skipped (no ADDY_API_KEY)\n"));
	console.log(bold(`\naddy.io  ${dim(base)}`));

	// Laravel picks JSON-vs-redirect from these two. Either alone is enough to get a JSON 401 out
	// of an unauthenticated request; both are sent because a redirect to the HTML login page is
	// the one failure mode that reaches a browser as an opaque error.
	const headers = {
		Authorization: `Bearer ${key}`,
		"Content-Type": "application/json",
		Accept: "application/json",
		"X-Requested-With": "XMLHttpRequest",
	};

	await call("GET api-token-details", `${base}/api/v1/api-token-details`, { headers });
	const domains = await call("GET domain-options", `${base}/api/v1/domain-options`, { headers });
	console.log(dim(`     domains: ${JSON.stringify(pick(domains.body, "data"))}`));
	const account = await call("GET account-details", `${base}/api/v1/account-details`, { headers });
	const d = account.body as { data?: Record<string, unknown> } | undefined;
	console.log(
		dim(
			`     quota: active_shared_domain_alias_count=${d?.data?.active_shared_domain_alias_count} limit=${d?.data?.active_shared_domain_alias_limit}`,
		),
	);
	await corsMatrix("api-token-details", `${base}/api/v1/api-token-details`, headers);

	if (!CREATE) return;
	// `domain` is required, so a create cannot be attempted without discovery having worked first.
	const domain = (pick(domains.body, "data") as string[] | undefined)?.[0];
	if (!domain) return console.log(red("     no domain from domain-options; cannot create"));
	const created = await call("POST aliases", `${base}/api/v1/aliases`, {
		method: "POST",
		headers,
		// `format` deliberately omitted, to see whether the account default applies.
		body: JSON.stringify({ domain, description: DESCRIPTION }),
	});
	console.log(`     ${bold("alias:")} ${pick(created.body, "data.email")}`);
}

async function simplelogin() {
	const key = process.env.SIMPLELOGIN_API_KEY;
	const base = (process.env.SIMPLELOGIN_BASE_URL ?? "https://app.simplelogin.io").replace(
		/\/$/,
		"",
	);
	if (!key) return console.log(dim("\nsimplelogin: skipped (no SIMPLELOGIN_API_KEY)\n"));
	console.log(bold(`\nsimplelogin  ${dim(base)}`));

	// `Authentication`, not `Authorization`, and no Bearer prefix. Getting this wrong is a 401
	// that reads exactly like a bad key.
	const headers = { Authentication: key, "Content-Type": "application/json" };

	const info = await call("GET user_info", `${base}/api/user_info`, { headers });
	const u = info.body as { is_premium?: boolean; email?: string } | undefined;
	console.log(dim(`     account: ${u?.email} premium=${u?.is_premium}`));
	await corsMatrix("user_info", `${base}/api/user_info`, headers);

	if (!CREATE) return;
	const url = `${base}/api/alias/random/new?hostname=${encodeURIComponent(FOR_DOMAIN)}`;
	const created = await call("POST alias/random/new", url, {
		method: "POST",
		headers,
		body: JSON.stringify({ note: DESCRIPTION }),
	});
	console.log(`     ${bold("alias:")} ${pick(created.body, "email")}`);
}

async function relay() {
	const key = process.env.RELAY_API_KEY;
	const base = "https://relay.firefox.com";
	if (!key) return console.log(dim("\nrelay: skipped (no RELAY_API_KEY)\n"));
	console.log(bold(`\nrelay  ${dim(base)}`));

	// `Token`, not `Bearer`.
	const headers = { Authorization: `Token ${key}`, "Content-Type": "application/json" };

	const profiles = await call("GET profiles", `${base}/api/v1/profiles/`, { headers });
	const me = (profiles.body as { email?: string; has_premium?: boolean }[] | undefined)?.[0];
	console.log(dim(`     account: ${me?.email} premium=${me?.has_premium}`));
	await corsMatrix("profiles", `${base}/api/v1/profiles/`, headers);

	if (!CREATE) return;
	const created = await call("POST relayaddresses", `${base}/api/v1/relayaddresses/`, {
		method: "POST",
		headers,
		body: JSON.stringify({ enabled: true, generated_for: FOR_DOMAIN, description: DESCRIPTION }),
	});
	console.log(`     ${bold("alias:")} ${pick(created.body, "full_address")}`);
}

async function duckduckgo() {
	const token = process.env.DUCKDUCKGO_API_TOKEN;
	const base = "https://quack.duckduckgo.com";
	if (!token) return console.log(dim("\nduckduckgo: skipped (no DUCKDUCKGO_API_TOKEN)\n"));
	console.log(bold(`\nduckduckgo  ${dim(base)}`));

	const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

	// The only read-only endpoint found: an unauthenticated GET answers 401 where a nonexistent
	// path answers 404. Its body has never been seen, so print it whole rather than picking.
	const dash = await call("GET dashboard", `${base}/api/email/dashboard`, { headers });
	console.log(dim(`     dashboard: ${JSON.stringify(dash.body)?.slice(0, 200)}`));
	await corsMatrix("dashboard", `${base}/api/email/dashboard`, headers);

	if (!CREATE) return;
	// No body, no site, no description: the API accepts none of them.
	const created = await call("POST addresses", `${base}/api/email/addresses`, {
		method: "POST",
		headers,
	});
	console.log(`     ${bold("alias:")} ${pick(created.body, "address")}@duck.com`);
}

async function fastmail() {
	const token = process.env.FASTMAIL_API_TOKEN;
	if (!token) return console.log(dim("\nfastmail: skipped (no FASTMAIL_API_TOKEN)\n"));
	console.log(bold("\nfastmail"));

	const SESSION = "https://api.fastmail.com/jmap/session";
	const CAPABILITY = "https://www.fastmail.com/dev/maskedemail";
	const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

	const session = await call("GET jmap/session", SESSION, { headers });
	const s = session.body as
		| {
				apiUrl?: string;
				username?: string;
				primaryAccounts?: Record<string, string>;
				capabilities?: object;
				accounts?: Record<
					string,
					{
						name?: string;
						isPersonal?: boolean;
						isReadOnly?: boolean;
						accountCapabilities?: Record<string, unknown>;
					}
				>;
		  }
		| undefined;
	const apiUrl = s?.apiUrl;
	const accountId = s?.primaryAccounts?.[CAPABILITY];
	const account = accountId ? s?.accounts?.[accountId] : undefined;
	// The scope question from the doc: a masked-email-only token should still advertise the
	// capability while lacking urn:ietf:params:jmap:mail.
	console.log(dim(`     username: ${s?.username}`));
	console.log(dim(`     capabilities: ${Object.keys(s?.capabilities ?? {}).join(", ")}`));
	console.log(dim(`     accountId for maskedemail: ${accountId ?? red("absent")}`));
	console.log(
		dim(
			`     account: name=${account?.name} personal=${account?.isPersonal} readOnly=${account?.isReadOnly}`,
		),
	);
	console.log(
		dim(
			`     accountCapabilities: ${JSON.stringify(account?.accountCapabilities ?? {}).slice(0, 400)}`,
		),
	);

	await corsMatrix("jmap/session", SESSION, headers);

	// The pin from docs/email-aliases.md, exercised here so its cost is known before it is a
	// requirement in shipping code. Measured, the session names a per-datacentre host
	// (phl.api.fastmail.com), so same-origin is too strict: the token goes only to the session's
	// own host or a subdomain of it, over https.
	if (apiUrl) {
		const api = new URL(apiUrl);
		const sessionHost = new URL(SESSION).hostname;
		const pinned =
			api.protocol === "https:" &&
			(api.hostname === sessionHost || api.hostname.endsWith(`.${sessionHost}`));
		console.log(
			`     apiUrl ${apiUrl} ${pinned ? green("(within session host)") : red("(FOREIGN)")}`,
		);
		if (!pinned) return console.log(red("     refusing to send the token to a foreign apiUrl"));
	}

	// Error shapes, all read-only. JMAP reports most failures inside a 200, so what a client has to
	// parse is not just the HTTP status.
	await call("GET jmap/session (bad token)", SESSION, {
		headers: { ...headers, Authorization: "Bearer fmu1-not-a-real-token" },
	});
	if (!apiUrl || !accountId) return console.log(red("     no apiUrl/accountId; cannot go on"));
	const jmap = (methodCalls: unknown[], using = ["urn:ietf:params:jmap:core", CAPABILITY]) =>
		JSON.stringify({ using, methodCalls });
	const unknownCap = await call("POST unknown capability", apiUrl, {
		method: "POST",
		headers,
		body: jmap([["MaskedEmail/get", { accountId, ids: [] }, "0"]], ["urn:example:nope"]),
	});
	console.log(dim(`     body: ${unknownCap.raw.slice(0, 300)}`));
	const badAccount = await call("POST MaskedEmail/get (bogus accountId)", apiUrl, {
		method: "POST",
		headers,
		body: jmap([["MaskedEmail/get", { accountId: "u00000000", ids: [] }, "0"]]),
	});
	console.log(
		dim(`     methodResponses: ${JSON.stringify(pick(badAccount.body, "methodResponses"))}`),
	);
	// `ids: []` asks for nothing, so this proves the method is callable without reading any address.
	const empty = await call("POST MaskedEmail/get (ids: [])", apiUrl, {
		method: "POST",
		headers,
		body: jmap([["MaskedEmail/get", { accountId, ids: [] }, "0"]]),
	});
	console.log(dim(`     methodResponses: ${JSON.stringify(pick(empty.body, "methodResponses"))}`));
	// Whether the session host's own API path answers too, which would make the server-named
	// apiUrl optional rather than something the token has to follow.
	const direct = await call(
		"POST api.fastmail.com/jmap/api/ (ids: [])",
		"https://api.fastmail.com/jmap/api/",
		{
			method: "POST",
			headers,
			body: jmap([["MaskedEmail/get", { accountId, ids: [] }, "0"]]),
		},
	);
	console.log(dim(`     methodResponses: ${JSON.stringify(pick(direct.body, "methodResponses"))}`));

	if (!CREATE) return;
	const created = await call("POST MaskedEmail/set", apiUrl, {
		method: "POST",
		headers,
		body: jmap([
			[
				"MaskedEmail/set",
				{
					accountId,
					create: {
						// An origin, not a bare host: Fastmail's docs ask for protocol and domain.
						bramble: {
							state: "enabled",
							forDomain: `https://${FOR_DOMAIN}`,
							description: DESCRIPTION,
						},
					},
				},
				"0",
			],
		]),
	});
	console.log(
		dim(`     methodResponses: ${JSON.stringify(pick(created.body, "methodResponses"))}`),
	);
	const made = pick(created.body, "methodResponses.0.1.created.bramble") as
		| { id?: string; email?: string; state?: string }
		| undefined;
	console.log(`     ${bold("alias:")} ${made?.email} state=${made?.state}`);
	if (!made?.id) return;
	// What was actually stored, which is not always what was sent.
	const readBack = await call("POST MaskedEmail/get (the new one)", apiUrl, {
		method: "POST",
		headers,
		body: jmap([["MaskedEmail/get", { accountId, ids: [made.id] }, "0"]]),
	});
	console.log(
		dim(`     stored: ${JSON.stringify(pick(readBack.body, "methodResponses.0.1.list"))}`),
	);
}

/**
 * The candidate fourth provider. Domain-first and more so than Addy: the user must already have a
 * domain set up here, so what the spike is really measuring is whether that prerequisite is
 * discoverable enough to build a settings screen around.
 */
async function forwardEmail() {
	const token = process.env.FORWARDEMAIL_API_KEY;
	if (!token) return console.log(dim("\nforwardemail: skipped (no FORWARDEMAIL_API_KEY)\n"));
	console.log(bold("\nforwardemail"));

	const base = "https://api.forwardemail.net";
	// HTTP Basic with the token as the username and no password.
	const headers = {
		Authorization: `Basic ${Buffer.from(`${token}:`).toString("base64")}`,
		"Content-Type": "application/json",
	};

	const domains = await call("GET v1/domains", `${base}/v1/domains`, { headers });
	// An error body is an object, not the array the success path returns. Worth guarding rather
	// than assuming: this provider answers an unverified account with a 401 whose message is not
	// about the key at all, which is exactly the case the real client has to render.
	const names = Array.isArray(domains.body)
		? (domains.body as { name?: string }[]).map((d) => d.name)
		: [];
	console.log(dim(`     domains: ${JSON.stringify(names)}`));
	await corsMatrix("v1/domains", `${base}/v1/domains`, headers);

	if (!CREATE) return;
	const domain = process.env.FORWARDEMAIL_DOMAIN ?? names[0];
	if (!domain) return console.log(red("     no domain on this account; cannot create"));
	// `name` omitted on purpose: the server generates a random one, which is the whole ask.
	const created = await call("POST aliases", `${base}/v1/domains/${domain}/aliases`, {
		method: "POST",
		headers,
		body: JSON.stringify({ description: DESCRIPTION, is_enabled: true }),
	});
	// Only on success: this provider answers a free plan with a 402, and printing the address
	// unconditionally reported "undefined@domain" as though something had been made.
	if (created.status >= 200 && created.status < 300) {
		console.log(`     ${bold("alias:")} ${pick(created.body, "name")}@${domain}`);
	}
}

const PROVIDERS = { addy, simplelogin, relay, duckduckgo, fastmail, forwardemail: forwardEmail };

// --only exists because a create is not free. Re-running the whole set to exercise one provider
// spends an Addy alias out of ten every time.
const only = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);
const selected = Object.entries(PROVIDERS).filter(([name]) => !only || name === only);
if (only && selected.length === 0) {
	console.log(
		red(`\nunknown provider ${only}; expected one of ${Object.keys(PROVIDERS).join(", ")}`),
	);
	process.exit(1);
}

console.log(
	CREATE
		? red(
				`\nCREATE MODE: this will make one real alias per configured provider, for ${FOR_DOMAIN}.`,
			)
		: dim("\nRead-only. Pass --create to also create one alias per configured provider."),
);

for (const [, run] of selected) await run();
console.log("");
