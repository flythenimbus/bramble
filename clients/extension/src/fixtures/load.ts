const fixtures = import.meta.glob<string>("./sites/*.html", {
	eager: true,
	query: "?raw",
	import: "default",
});

/** Load a fixture HTML file from sites/ into document.body. */
export function loadFixture(name: string): void {
	const key = `./sites/${name}.html`;
	const html = fixtures[key];
	if (typeof html !== "string") {
		throw new Error(`no fixture: ${name} (looked for ${key})`);
	}
	document.body.innerHTML = html;
}
