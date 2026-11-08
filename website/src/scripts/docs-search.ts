import type MiniSearch from "minisearch";
import type { SearchResult } from "minisearch";
import { DOC_KINDS } from "@/docs-sections";

/**
 * Docs search, run in the browser over the index the site builds at /docs/search.json, so a
 * query never leaves the device. Each article's `keywords` carry the other ways people phrase it.
 *
 * MiniSearch ranks the matches, weighted by field, with prefix matching and typo tolerance.
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
	/** The article's words that matched, to highlight. */
	terms: string[];
}

export interface SearchIndex {
	mini: MiniSearch<SearchDoc>;
	docs: Map<string, SearchDoc>;
}

const BOOST = {
	title: 10,
	keywords: 6,
	headings: 4,
	description: 3,
	section: 2,
	body: 1,
} satisfies Partial<Record<keyof SearchDoc, number>>;

/** A query that asks why or describes a problem wants the Q&A articles; anything else, the guide. */
const WANTS_ANSWER =
	/\b(why|not|no|never|won'?t|can'?t|cannot|doesn'?t|didn'?t|isn'?t|broken|fail\w*|error|stuck|problem|issue|wrong)\b/;

const STOPWORDS = new Set(
	"a an and are as at be but by can do does for from how i if in into is it its me my not of on or so that the their them then there this to was what when where which who why will with you your".split(
		" ",
	),
);

let loading: Promise<SearchIndex> | undefined;

export function loadIndex(): Promise<SearchIndex> {
	loading ??= fetch("/docs/search.json")
		.then((res) => {
			if (!res.ok) throw new Error(`search index: HTTP ${res.status}`);
			return res.json() as Promise<SearchDoc[]>;
		})
		.then(createIndex)
		.catch((err) => {
			loading = undefined;
			throw err;
		});
	return loading;
}

/** MiniSearch is loaded here, the first time someone searches, so docs pages don't carry it. */
export async function createIndex(docs: SearchDoc[]): Promise<SearchIndex> {
	const { default: MiniSearch } = await import("minisearch");
	const fields = Object.keys(BOOST) as (keyof typeof BOOST)[];
	const vocabulary = [...new Set(docs.flatMap((doc) => fields.flatMap((f) => tokenize(doc[f]))))];
	const inDocs = (term: string) => vocabulary.some((word) => word.startsWith(term));
	const mini = new MiniSearch<SearchDoc>({
		idField: "href",
		fields,
		tokenize,
		processTerm: (term) => (isWord(term) ? term : null),
		searchOptions: {
			boost: BOOST,
			processTerm: (term) => (isWord(term) ? stem(term) : null),
			prefix: true,
			// Only a word found nowhere in the docs is taken as a typo.
			fuzzy: (term) => (inDocs(term) ? false : typosAllowed(term)),
			weights: { prefix: 0.8, fuzzy: 0.45 },
		},
	});
	mini.addAll(docs);
	return { mini, docs: new Map(docs.map((doc) => [doc.href, doc])) };
}

function fold(text: string) {
	return text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

function tokenize(text: string) {
	return fold(text).split(/[^a-z0-9]+/);
}

function isWord(term: string) {
	return term.length > 1 && !STOPWORDS.has(term);
}

/** One wrong letter from 4 letters, two from 7. Shorter words must be spelled right. */
function typosAllowed(term: string) {
	if (term.length >= 7) return 2;
	if (term.length >= 4) return 1;
	return false;
}

/** "pairing" finds "pair", "devices" finds "device": strip a common suffix off longer words. */
function stem(word: string) {
	if (word.length <= 4) return word;
	return word.replace(/(ing|ed|es|s)$/, "");
}

export function search(index: SearchIndex, query: string, limit = 8): SearchHit[] {
	const wantsAnswer = WANTS_ANSWER.test(fold(query));
	const boostDocument = (href: string) => {
		const question = index.docs.get(href)?.kind === DOC_KINDS.question;
		if (wantsAnswer) return question ? 2 : 1;
		return question ? 1 : 1.25;
	};

	// Articles with every word, else the ones with the most words.
	let results = index.mini.search(query, { combineWith: "AND", boostDocument });
	if (results.length === 0) {
		results = index.mini
			.search(query, { boostDocument })
			.sort((a, b) => b.queryTerms.length - a.queryTerms.length || b.score - a.score);
	}

	return results.slice(0, limit).map((result) => {
		const doc = index.docs.get(result.id) as SearchDoc;
		return { doc, terms: result.terms, excerpt: excerptFor(doc, result) };
	});
}

function excerptFor(doc: SearchDoc, { match }: SearchResult) {
	const fields = Object.values(match).flat();
	if (fields.includes("title") || fields.includes("description")) return undefined;
	const body = fold(doc.body);
	let at = -1;
	for (const [term, where] of Object.entries(match)) {
		if (!where.includes("body")) continue;
		const m = wholeWord(term).exec(body);
		if (m && (at === -1 || m.index < at)) at = m.index;
	}
	if (at === -1) return undefined;
	const start = Math.max(0, doc.body.lastIndexOf(" ", Math.max(0, at - 60)) + 1);
	const end = Math.min(doc.body.length, start + 160);
	return `${start > 0 ? "…" : ""}${doc.body.slice(start, end).trim()}${end < doc.body.length ? "…" : ""}`;
}

function escapeRe(s: string) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wholeWord(term: string) {
	return new RegExp(`(?:^|[^a-z0-9])${escapeRe(term)}(?![a-z0-9])`);
}

function escapeHtml(s: string) {
	return s.replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
	);
}

/** Escaped HTML with each matched word wrapped in <mark>. */
export function highlight(text: string, terms: string[]) {
	const html = escapeHtml(text);
	if (terms.length === 0) return html;
	const re = new RegExp(
		`(^|[^\\p{L}\\p{N}])(${terms.map(escapeRe).join("|")})(?![\\p{L}\\p{N}])`,
		"giu",
	);
	return html.replace(re, "$1<mark>$2</mark>");
}
