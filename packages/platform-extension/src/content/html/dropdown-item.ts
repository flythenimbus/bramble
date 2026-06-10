import { html } from "../template";

/** Uppercase avatar initials: first letter of the first two words, else first two letters. */
function initials(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) return "??";
	const words = trimmed.split(/\s+/);
	if (words.length >= 2 && words[0] && words[1]) {
		return (words[0][0]! + words[1][0]!).toUpperCase();
	}
	return trimmed.slice(0, 2).toUpperCase();
}

// Stable colour per entry: same name always lands on the same swatch.
const AVATAR_COLORS = [
	"#7C3AED",
	"#2563EB",
	"#0891B2",
	"#059669",
	"#65A30D",
	"#CA8A04",
	"#EA580C",
	"#DC2626",
	"#DB2777",
];

function colorForName(name: string): string {
	let hash = 0;
	for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
	return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

export function dropdownItem({
	id,
	name,
	secondary,
}: {
	id: string;
	name: string;
	secondary: string;
}) {
	return html`
    <div class="tp-item" data-entry-id="${id}">
  		<div class="tp-avatar" style="background: ${colorForName(name)};">
        ${initials(name)}
  		</div>
  		<div class="tp-text">
        <span class="tp-name">${name}</span>
        <span class="tp-user">${secondary}</span>
  		</div>
   	</div>
  `;
}
