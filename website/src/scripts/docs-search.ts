import { DOC_KINDS } from "@/docs-sections";

/**
 * Docs search, run in the browser over the index the site builds at /docs/search.json, so a
 * query never leaves the device. Each article's `keywords` carry the other ways people phrase it.
 *
 * Keyword matching with prefix and light suffix stripping, weighted by where a word appears.
 */

export interface SearchDoc {
	href: string;
	title: string;
	description: string;
	section: string;
	kind: string;
	keywords: string;
	headings: string;
	body: string;
}

export interface SearchHit {
	doc: SearchDoc;
	/** Body text around the first match, when the match isn't in the title or description. */
	excerpt?: string;
	terms: string[];
}

const WEIGHTS = [
	["title", 10],
	["keywords", 6],
	["headings", 4],
	["description", 3],
	["section", 2],
	["body", 1],
] as const satisfies readonly (readonly [keyof SearchDoc, number])[];

const WHOLE_FIELDS = ["title", "keywords", "headings", "description"] as const;

/** A query that describes a problem wants the Q&A articles, not the how-to. */
const PROBLEM =
	/\b(not|no|never|won'?t|can'?t|cannot|doesn'?t|didn'?t|isn'?t|broken|fail\w*|error|stuck|problem|issue|wrong)\b/;

const STOPWORDS = new Set(
	"a an and are as at be but by can do does for from how i if in into is it its me my not of on or so that the their them then there this to was what when where which who why will with you your".split(
		" ",
	),
);

type Prepared = { doc: SearchDoc; lower: Record<keyof SearchDoc, string> };

let loading: Promise<Prepared[]> | undefined;

export function loadIndex(): Promise<Prepared[]> {
	loading ??= fetch("/docs/search.json")
		.then((res) => {
			if (!res.ok) throw new Error(`search index: HTTP ${res.status}`);
			return res.json() as Promise<SearchDoc[]>;
		})
		.then(prepare)
		.catch((err) => {
			loading = undefined;
			throw err;
		});
	return loading;
}

export function prepare(docs: SearchDoc[]): Prepared[] {
	return docs.map((doc) => ({
		doc,
		lower: Object.fromEntries(
			Object.entries(doc).map(([k, v]) => [k, fold(v)]),
		) as Prepared["lower"],
	}));
}

function fold(text: string) {
	return text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

/** "pairing" finds "pair", "devices" finds "device": strip a common suffix off longer words. */
function stem(word: string) {
	if (word.length <= 4) return word;
	return word.replace(/(ing|ed|es|s)$/, "");
}

export function terms(query: string) {
	const words = fold(query)
		.split(/[^a-z0-9]+/)
		.filter((w) => w.length > 1 && !STOPWORDS.has(w));
	return [...new Set(words.map(stem))];
}

function escapeRe(s: string) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordStart(term: string) {
	return new RegExp(`(?:^|[^a-z0-9])${escapeRe(term)}`);
}

export function search(index: Prepared[], query: string, limit = 8): SearchHit[] {
	const qs = terms(query);
	if (qs.length === 0) return [];
	const phrase = fold(query).trim();
	const problem = PROBLEM.test(phrase);
	const res = qs.map(wordStart);

	const scored = index.flatMap(({ doc, lower }) => {
		let matched = 0;
		let score = 0;
		for (const re of res) {
			const best = Math.max(0, ...WEIGHTS.map(([field, w]) => (re.test(lower[field]) ? w : 0)));
			if (best > 0) matched++;
			score += best;
		}
		if (matched === 0) return [];
		if (lower.title.includes(phrase)) score += 8;
		if (lower.keywords.includes(phrase)) score += 10;
		// Every word in one place (a keyword like an error message, a heading) beats scattered hits.
		if (WHOLE_FIELDS.some((field) => res.every((re) => re.test(lower[field])))) score += 12;
		if (problem && doc.kind === DOC_KINDS.question) score += 20;
		return [{ doc, lower, matched, score }];
	});

	scored.sort((a, b) => b.matched - a.matched || b.score - a.score);
	// Drop weak partial matches once a result matches every word.
	const top = scored[0]?.matched ?? 0;
	return scored
		.filter((s) => s.matched === top || top < qs.length)
		.slice(0, limit)
		.map(({ doc, lower }) => ({ doc, terms: qs, excerpt: excerptFor(doc, lower, res) }));
}

function excerptFor(doc: SearchDoc, lower: Prepared["lower"], res: RegExp[]) {
	if (res.some((re) => re.test(lower.title) || re.test(lower.description))) return undefined;
	let at = -1;
	for (const re of res) {
		const m = re.exec(lower.body);
		if (m && (at === -1 || m.index < at)) at = m.index;
	}
	if (at === -1) return undefined;
	const start = Math.max(0, doc.body.lastIndexOf(" ", Math.max(0, at - 60)) + 1);
	const end = Math.min(doc.body.length, start + 160);
	return `${start > 0 ? "…" : ""}${doc.body.slice(start, end).trim()}${end < doc.body.length ? "…" : ""}`;
}

function escapeHtml(s: string) {
	return s.replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
	);
}

/** Escaped HTML with each word that starts with a search term wrapped in <mark>. */
export function highlight(text: string, qs: string[]) {
	const html = escapeHtml(text);
	if (qs.length === 0) return html;
	const re = new RegExp(
		`(^|[^\\p{L}\\p{N}])((?:${qs.map(escapeRe).join("|")})[\\p{L}\\p{N}]*)`,
		"giu",
	);
	return html.replace(re, "$1<mark>$2</mark>");
}
