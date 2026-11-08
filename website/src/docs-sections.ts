/** Sidebar and front-page order. An article's `section` must be one of these ids. */
export const DOC_SECTIONS = [
	{
		id: "start",
		title: "Getting started",
		description: "Install Bramble, create your vault and learn your way around.",
	},
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
		id: "autofill",
		title: "Autofill",
		description: "Fill passwords, codes and cards in your browser and apps.",
	},
	{
		id: "passkeys",
		title: "Passkeys",
		description: "Save passkeys in Bramble and sign in with them.",
	},
	{
		id: "sync",
		title: "Syncing devices",
		description: "Keep one vault on your phones, computers and browsers.",
	},
	{
		id: "backups",
		title: "Backups and export",
		description: "Keep encrypted copies of your vault, restore one, or export it.",
	},
	{
		id: "desktop",
		title: "Desktop app",
		description: "Install Bramble on your computer and link the browser extension.",
	},
	{
		id: "privacy",
		title: "Security and privacy",
		description: "How your vault is protected, and what Bramble can and can't see.",
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
