import { z } from "zod";

// The unlock screen's search: `redirect` is the screen a lock interrupted, reopened once the
// vault unlocks. Only an in-app path is taken; anything else falls back to the vault list.
export const authSearchSchema = z.object({
	redirect: z
		.string()
		.refine((href) => href.startsWith("/") && !href.startsWith("//"))
		.optional()
		.catch(undefined),
});
