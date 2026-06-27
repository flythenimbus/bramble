// Local, offline translation via Ollama. Two shapes: `translateBatch` for arrays
// of short UI strings (JSON in/out, chunked + retried), and `translateText` for a
// single prose blob (store descriptions, release notes).

const MODEL = process.env.I18N_MODEL ?? "gemma4:e4b-mlx";
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
// Small models drop/add an item on long arrays; smaller chunks validate far more
// reliably (a mismatch forces a slow per-string fallback for the whole chunk).
const CHUNK = Number(process.env.I18N_CHUNK ?? 10);

export const modelInfo = `${MODEL} @ ${OLLAMA_HOST}`;

const GUIDANCE =
	`Keep the tone concise and trustworthy. Use a consistently FORMAL register ` +
	`throughout (e.g. "Sie" in German, "usted" in Spanish, "vous" in French, ` +
	`"Lei" in Italian); never switch to informal address. Preserve placeholders ` +
	`verbatim and in place: {appName}, %s, %d, %1$s and similar. Do not translate ` +
	`brand or standard terms (Bramble, Face ID, Touch ID, Optic ID, AES-256-GCM, ` +
	`KeePass, TOTP).`;

async function chat(system, user) {
	const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: MODEL,
			stream: false,
			options: { temperature: 0 },
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
		}),
	});
	if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
	const data = await res.json();
	// Some reasoning models wrap a scratchpad in <think>…</think>; drop it.
	return (data.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "");
}

async function batchOnce(language, strings) {
	const system =
		`You are a professional software-UI translator localizing a privacy-focused ` +
		`password manager into ${language}. ${GUIDANCE} Output ONLY a JSON array of ` +
		`the translated strings in the same order as the input, nothing else.`;
	const text = await chat(system, JSON.stringify(strings));
	const json = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
	const out = JSON.parse(json);
	if (out.length !== strings.length) {
		throw new Error(`count mismatch: sent ${strings.length}, got ${out.length}`);
	}
	return out;
}

// Small models occasionally return the wrong array length; retry, then fall back
// to one-at-a-time (always 1:1).
async function resilient(language, strings, attempts = 3) {
	for (let i = 0; i < attempts; i++) {
		try {
			return await batchOnce(language, strings);
		} catch (e) {
			if (i < attempts - 1) continue;
			if (strings.length === 1) throw e;
			console.warn(`    chunk failed (${e.message}); per-string fallback`);
			const out = [];
			for (const s of strings) out.push(...(await resilient(language, [s], attempts)));
			return out;
		}
	}
}

export async function translateBatch(language, strings) {
	const out = [];
	for (let i = 0; i < strings.length; i += CHUNK) {
		out.push(...(await resilient(language, strings.slice(i, i + CHUNK))));
	}
	return out;
}

export async function translateText(language, text, extra = "") {
	const system =
		`You are a professional translator localizing marketing/store copy for a ` +
		`privacy-focused password manager into ${language}. ${GUIDANCE} Preserve line ` +
		`breaks and formatting. ${extra} Output ONLY the translated text, nothing else.`;
	return (await chat(system, text)).trim();
}
