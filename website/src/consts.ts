export const SITE = {
	name: "Bramble",
	domain: "bramble.sh",
	url: "https://bramble.sh",
	tagline: "Your passwords never leave your devices.",
	description:
		"Bramble is a local-first password manager for your browser and phone. No account, no server holding your vault, no company to breach. You hold the vault, you hold the password.",
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
	{ label: "Platforms", href: "/#platforms" },
	{ label: "Security", href: "/#security" },
	{ label: "FAQ", href: "/#faq" },
] as const;
