// Ambient declaration so `tsc` accepts asset imports; the bundler resolves them to URLs.
declare module "*.png" {
	const src: string;
	export default src;
}
