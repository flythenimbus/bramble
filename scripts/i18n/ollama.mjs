// Translation backend. Defaults to local Ollama (offline); if DEEPSEEK_API_KEY is
// set (e.g. in .env.local) it routes to DeepSeek's OpenAI-compatible API instead.
// Two shapes: `translateBatch` for arrays of short UI strings (JSON in/out,
// chunked + retried), and `translateText` for a single prose blob.

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const API_BASE = process.env.I18N_API_BASE ?? "https://api.deepseek.com";
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const MODEL = process.env.I18N_MODEL ?? (DEEPSEEK_KEY ? "deepseek-v4-pro" : "gemma4:e4b-mlx");
// Small models drop/add an item on long arrays; smaller chunks validate far more
// reliably (a mismatch forces a slow per-string fallback for the whole chunk).
// DeepSeek handles bigger batches fine, so widen the chunk there.
const CHUNK = Number(process.env.I18N_CHUNK ?? (DEEPSEEK_KEY ? 40 : 10));

export const modelInfo = DEEPSEEK_KEY ? `${MODEL} @ deepseek` : `${MODEL} @ ${OLLAMA_HOST}`;

const GUIDANCE =
	`Keep the tone concise and trustworthy. Write buttons, labels and short captions the way ` +
	`native UI does — normally the infinitive ("Neues Login erstellen", "Crear una cuenta", ` +
	`"Créer un compte", "Creare un account") — not as an instruction addressed to the user. ` +
	`Where a string IS a full sentence, use a FORMAL register ("Sie", "usted", "vous", "Lei"); ` +
	`never use informal address. Preserve placeholders verbatim and in place ({appName}, %s, ` +
	`%d, %@, %lld, %1$s and similar). Never translate brand or standard terms (Bramble, ` +
	`Face ID, Touch ID, Optic ID, AES-256-GCM, KeePass, TOTP).`;

// Appended to the translation prompts: a cheap self-review pass catches the failures we
// otherwise only detect after the fact (count/placeholder drift) or not at all (stilted
// phrasing), and costs one round trip instead of a retry.
const SELF_CHECK =
	`Before answering, re-read each translation and check it: the item count and order match ` +
	`the input, every placeholder is intact, the register is right, and a native speaker would ` +
	`phrase it that way in an app. Silently fix any that fail, then output the final result.`;

async function chat(system, user) {
	const messages = [
		{ role: "system", content: system },
		{ role: "user", content: user },
	];
	let content;
	if (DEEPSEEK_KEY) {
		const res = await fetch(`${API_BASE}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${DEEPSEEK_KEY}` },
			body: JSON.stringify({ model: MODEL, temperature: 0, messages }),
		});
		if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${await res.text()}`);
		content = (await res.json()).choices?.[0]?.message?.content ?? "";
	} else {
		const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: MODEL, stream: false, options: { temperature: 0 }, messages }),
		});
		if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
		content = (await res.json()).message?.content ?? "";
	}
	// Some reasoning models wrap a scratchpad in <think>…</think>; drop it.
	return content.replace(/<think>[\s\S]*?<\/think>/g, "");
}

// Placeholders that must survive translation unchanged: {x}, %@, %lld, %s, %1$s, etc.
const PLACEHOLDER = /\{[^}]+\}|%[0-9]*\$?[@a-z]+/gi;
const placeholders = (s) => (s.match(PLACEHOLDER) ?? []).sort().join(",");

async function batchOnce(language, strings) {
	const system =
		`You are a professional software-UI translator localizing a privacy-focused ` +
		`password manager into ${language}. ${GUIDANCE} ${SELF_CHECK} Output ONLY a JSON array ` +
		`of the translated strings in the same order as the input, nothing else.`;
	const text = await chat(system, JSON.stringify(strings));
	const json = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
	const out = JSON.parse(json);
	if (out.length !== strings.length) {
		throw new Error(`count mismatch: sent ${strings.length}, got ${out.length}`);
	}
	// A dropped/mangled placeholder (e.g. %@ -> @) breaks formatting at runtime; reject so
	// the caller retries, then falls back to per-string.
	strings.forEach((src, i) => {
		if (placeholders(src) !== placeholders(out[i])) {
			throw new Error(`placeholder mismatch in ${JSON.stringify(out[i])}`);
		}
	});
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
		`breaks and formatting. ${extra} ${SELF_CHECK} Output ONLY the translated text, nothing else.`;
	return (await chat(system, text)).trim();
}

// Shorten text to at most `limit` characters, intelligently. `kind` is "keywords"
// (comma-separated; drop least-important terms) or "text" (rephrase tighter).
// Tries the model a few times, keeping the best under-limit candidate.
export async function fitToLimit(language, text, limit, kind) {
	let best = text.trim();
	for (let i = 0; i < 3 && best.length > limit; i++) {
		const system =
			kind === "keywords"
				? `You are optimizing an App Store keyword list in ${language}. Shorten it to AT ` +
					`MOST ${limit} characters total (counting commas) by dropping the least valuable ` +
					`keywords and preferring shorter synonyms. Keep it comma-separated with NO spaces ` +
					`after commas, keep the highest-value search terms, keep brand/standard terms ` +
					`(Bramble, TOTP, KeePass). ${GUIDANCE} Output ONLY the keyword list.`
				: `You are editing App Store copy in ${language}. Rewrite the text so it is AT MOST ` +
					`${limit} characters while preserving the core meaning and a natural, formal tone. ` +
					`Be concise; drop secondary clauses if needed. ${GUIDANCE} Output ONLY the rewritten text.`;
		const out = (await chat(system, best)).trim().replace(kind === "keywords" ? /\s*,\s*/g : / +/g, kind === "keywords" ? "," : " ");
		if (out && out.length < best.length) best = out;
	}
	return best;
}
