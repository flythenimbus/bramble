import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";
import { DOC_SECTION_IDS } from "./docs-sections";

const blog = defineCollection({
	loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/blog" }),
	schema: z.object({
		title: z.string(),
		/** Meta description and the excerpt on the index. */
		description: z.string(),
		pubDate: z.coerce.date(),
		/** Set when a post is edited after publishing, so a reader knows it still holds. */
		updatedDate: z.coerce.date().optional(),
		/** Hidden from the index and from the build. */
		draft: z.boolean().default(false),
	}),
});

const docs = defineCollection({
	loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/docs" }),
	schema: z.object({
		title: z.string(),
		/** Meta description, the line under the title, and the search snippet. */
		description: z.string(),
		section: z.enum(DOC_SECTION_IDS),
		kind: z.enum(["guide", "question"]),
		/** Position among the section's articles of the same kind. */
		order: z.number().default(100),
		/** Words people search for that the article doesn't use, and error messages it covers. */
		keywords: z.array(z.string()).default([]),
		updatedDate: z.coerce.date(),
		/** Shown by `astro dev` only, left out of the build. */
		draft: z.boolean().default(false),
	}),
});

export const collections = { blog, docs };
