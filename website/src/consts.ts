export const SITE = {
	name: "Bramble",
	domain: "bramble.sh",
	url: "https://bramble.sh",
	tagline: "A password manager that syncs between your devices",
	description:
		"Bramble syncs your passwords between your phone, computer and browser. Everything is end-to-end encrypted. Your passwords are saved only on your devices, not on a server. You do not need an account, and only you can open your vault.",
	contactEmail: "flythenimbus@pm.me",
} as const;

export const LINKS = {
	github: "https://github.com/flythenimbus/bramble",
	chrome: "https://chromewebstore.google.com/detail/bramble/kmokhdhoggbdcgoepifeckhgbfakaknm",
	firefox: "https://addons.mozilla.org/firefox/addon/bramble/",
	ios: "https://apps.apple.com/us/app/bramble-password-manager/id6783071787",
	android: "https://github.com/flythenimbus/bramble/releases",
	matrix: "https://matrix.to/#/%23general:bramble.sh",
} as const;

export const BUTTONDOWN = {
	// Buttondown username (Settings -> Embedding). The newsletter form POSTs to
	// buttondown.com/api/emails/embed-subscribe/<username>.
	username: "bramble.sh",
} as const;

export const NAV = [
	{ label: "Screenshots", href: "/#screenshots" },
	{ label: "Features", href: "/#features" },
	{ label: "Security", href: "/#security" },
	{ label: "Blog", href: "/blog" },
	{ label: "FAQ", href: "/#faq" },
] as const;
