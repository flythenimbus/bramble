import type { APIRoute } from "astro";
import { DOC_KINDS, docHref, getDocs, sectionOf } from "@/docs";
import type { SearchDoc } from "@/scripts/docs-search";

/** MDX source to plain words: drops imports, JSX tags, link targets and markdown punctuation. */
function plainText(mdx: string) {
	return mdx
		.replace(/^(import|export)\s.*$/gm, "")
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/^\s*\|?[\s:|-]*-{3,}[\s:|-]*$/gm, "")
		.replace(
			/^\s*\|(.*)\|\s*$/gm,
			(_, row: string) =>
				`${row
					.split("|")
					.map((c) => c.trim())
					.join(" · ")} ·`,
		)
		.replace(/<[^>]+>/g, " ")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_`#>|]/g, "")
		.replace(/^\s*(?:\d+\.|-)\s+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
}

export const GET: APIRoute = async () => {
	const docs = await getDocs();
	const index: SearchDoc[] = docs.map((doc) => {
		const body = doc.body ?? "";
		return {
			href: docHref(doc),
			title: doc.data.title,
			description: doc.data.description,
			section: sectionOf(doc).title,
			kind: DOC_KINDS[doc.data.kind],
			keywords: doc.data.keywords.join(" · "),
			headings: [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map((m) => m[1]).join(" · "),
			body: plainText(body),
		};
	});
	return new Response(JSON.stringify(index), {
		headers: { "Content-Type": "application/json" },
	});
};
