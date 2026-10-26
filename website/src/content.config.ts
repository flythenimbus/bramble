import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

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

export const collections = { blog };
