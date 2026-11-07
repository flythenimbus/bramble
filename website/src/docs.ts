import { type CollectionEntry, getCollection } from "astro:content";
import { DOC_KINDS, DOC_SECTIONS, type DocSection } from "@/docs-sections";

export { DOC_KINDS, DOC_SECTIONS, type DocSection };
export type Doc = CollectionEntry<"docs">;

export function docHref(doc: Doc) {
	return `/docs/${doc.id}`;
}

export function sectionOf(doc: Doc): DocSection {
	return DOC_SECTIONS.find((s) => s.id === doc.data.section) as DocSection;
}

/**
 * Articles in reading order: section, then guides before questions, then `order`.
 * Drafts show in `astro dev` only, so an article can wait for the release it describes.
 */
export async function getDocs() {
	const docs = await getCollection("docs", ({ data }) => import.meta.env.DEV || !data.draft);
	const sectionIndex = (doc: Doc) => DOC_SECTIONS.findIndex((s) => s.id === doc.data.section);
	const kindIndex = (doc: Doc) => (doc.data.kind === "guide" ? 0 : 1);
	return docs.sort(
		(a, b) =>
			sectionIndex(a) - sectionIndex(b) ||
			kindIndex(a) - kindIndex(b) ||
			a.data.order - b.data.order ||
			a.data.title.localeCompare(b.data.title),
	);
}

/** Sections that have at least one article, each with its articles in reading order. */
export function groupBySection(docs: Doc[]) {
	return DOC_SECTIONS.map((section) => ({
		section,
		docs: docs.filter((d) => d.data.section === section.id),
	})).filter((group) => group.docs.length > 0);
}
