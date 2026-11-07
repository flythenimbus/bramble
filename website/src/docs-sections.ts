/** Sidebar and front-page order. An article's `section` must be one of these ids. */
export const DOC_SECTIONS = [
	{
		id: "import",
		title: "Importing",
		description: "Bring your passwords, codes and passkeys from another app.",
	},
	{
		id: "unlock",
		title: "Unlocking",
		description:
			"Master password, Face ID, Touch ID, Windows Hello, security keys and recovery codes.",
	},
	{
		id: "sync",
		title: "Syncing devices",
		description: "Keep one vault on your phones, computers and browsers.",
	},
	{
		id: "backups",
		title: "Backups",
		description: "Keep encrypted copies of your vault, and restore one when you need it.",
	},
	{
		id: "desktop",
		title: "Desktop app",
		description: "Link the browser extension to Bramble on your computer.",
	},
] as const;

export type DocSection = (typeof DOC_SECTIONS)[number];
export type DocSectionId = DocSection["id"];

export const DOC_SECTION_IDS = DOC_SECTIONS.map((s) => s.id) as [DocSectionId, ...DocSectionId[]];

/** Guides explain how to do something; questions answer one problem. */
export const DOC_KINDS = {
	guide: "Guide",
	question: "Q&A",
} as const;
