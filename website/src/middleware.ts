import { defineMiddleware } from "astro:middleware";

// Inlined icons are decorative: whatever contains one is named on its own. Without this they reach
// screen readers as unnamed images. An <svg> that carries a role or label is left alone.
const UNLABELLED_SVG = /<svg\b(?![^>]*\b(?:aria-hidden|aria-label|aria-labelledby|role)=)/g;

export const onRequest = defineMiddleware(async (_context, next) => {
	const response = await next();
	if (!response.headers.get("content-type")?.includes("text/html")) return response;
	const html = (await response.text()).replace(UNLABELLED_SVG, '<svg aria-hidden="true"');
	return new Response(html, response);
});
