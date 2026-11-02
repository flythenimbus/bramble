import { z } from "zod";

// Kept apart from the screen so the router's eager import doesn't pull in the lazy route.
export const passkeyVerifySearchSchema = z.object({
	/** The provider's id for this request, echoed back with the answer. */
	id: z.string().catch(""),
	/** The site asking, shown to the user. */
	rp: z.string().catch(""),
});
