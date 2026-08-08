// The pairing SAS, as the user compares it. One component for both ends of the ceremony, so the
// inviter and the joiner cannot drift into showing the same bits differently.
//
// Emoji lead, because a row of distinct pictures is faster and more reliable to compare than
// twelve digits, and much harder to accept a near-miss on. Names sit under each one: the same
// codepoint is DRAWN differently on every platform, so what is really being compared is the
// concept, and the name is what makes it sayable out loud and readable by a screen reader.
//
// The digits stay, quietly, underneath. Comparison happens between TWO devices, and the other one
// may be a released version that only has digits. Without them there would be nothing to compare
// against and the user's options would be to guess or give up. Drop that row once no supported
// version is digits-only. See @core/sync/pairing-sas.

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { SAS_EMOJI } from "../../sync/sas-emoji";

/**
 * What each symbol is called, keyed by the symbol so it cannot silently drift out of step with
 * the alphabet's order (which is a wire format and must never move).
 *
 * One rule for translators: within a language these must stay mutually distinct, or verbal
 * comparison breaks in that language alone, which is the kind of bug nobody catches.
 */
const SAS_EMOJI_NAMES: Record<string, MessageDescriptor> = {
	"🐶": msg`Dog`,
	"🐱": msg`Cat`,
	"🦁": msg`Lion`,
	"🐎": msg`Horse`,
	"🦄": msg`Unicorn`,
	"🐷": msg`Pig`,
	"🐘": msg`Elephant`,
	"🐰": msg`Rabbit`,
	"🐼": msg`Panda`,
	"🐓": msg`Rooster`,
	"🐧": msg`Penguin`,
	"🐢": msg`Turtle`,
	"🐟": msg`Fish`,
	"🐙": msg`Octopus`,
	"🦋": msg`Butterfly`,
	"🌷": msg`Flower`,
	"🌳": msg`Tree`,
	"🌵": msg`Cactus`,
	"🍄": msg`Mushroom`,
	"🌏": msg`Globe`,
	"🌙": msg`Moon`,
	"☁️": msg`Cloud`,
	"🔥": msg`Fire`,
	"🍌": msg`Banana`,
	"🍎": msg`Apple`,
	"🍓": msg`Strawberry`,
	"🌽": msg`Corn`,
	"🍕": msg`Pizza`,
	"🎂": msg`Cake`,
	"❤️": msg`Heart`,
	"🙂": msg`Smiley`,
	"🤖": msg`Robot`,
	"🎩": msg`Hat`,
	"👓": msg`Glasses`,
	"🔧": msg`Spanner`,
	"🎅": msg`Santa`,
	"👍": msg`Thumbs up`,
	"☂️": msg`Umbrella`,
	"⌛": msg`Hourglass`,
	"⏰": msg`Clock`,
	"🎁": msg`Gift`,
	"💡": msg`Light bulb`,
	"📖": msg`Book`,
	"✏️": msg`Pencil`,
	"📎": msg`Paperclip`,
	"✂️": msg`Scissors`,
	"🔒": msg`Lock`,
	"🔑": msg`Key`,
	"🔨": msg`Hammer`,
	"☎️": msg`Telephone`,
	"🏁": msg`Flag`,
	"🚂": msg`Train`,
	"🚲": msg`Bicycle`,
	"✈️": msg`Aeroplane`,
	"🚀": msg`Rocket`,
	"🏆": msg`Trophy`,
	"⚽": msg`Ball`,
	"🎸": msg`Guitar`,
	"🎺": msg`Trumpet`,
	"🔔": msg`Bell`,
	"⚓": msg`Anchor`,
	"🎧": msg`Headphones`,
	"📁": msg`Folder`,
	"📌": msg`Pin`,
};

/** Exported for the test that asserts every symbol in the alphabet has a name. */
export const sasEmojiNames = SAS_EMOJI_NAMES;

interface SasDisplayProps {
	/** The 12-digit form. Always present. */
	digits: string;
	/** Seven indices into the emoji alphabet. Absent from a peer that predates the emoji SAS. */
	emoji?: number[];
	/** Larger type, for the full-screen joiner view rather than a modal. */
	large?: boolean;
}

export function SasDisplay({ digits, emoji, large }: SasDisplayProps) {
	const { i18n } = useLingui();
	const indices = emoji ?? [];
	const symbols = indices.flatMap((i) => {
		const char = SAS_EMOJI[i];
		const name = char === undefined ? undefined : SAS_EMOJI_NAMES[char];
		return char !== undefined && name !== undefined ? [{ char, name }] : [];
	});
	// An index we have no symbol for can only come from a peer on a newer alphabet, and showing a
	// gap where it has a picture would read as a mismatch. Fall back to digits for the whole row
	// rather than displaying something the other device cannot be compared against.
	const renderable = symbols.length > 0 && symbols.length === indices.length;

	if (!renderable) {
		return <p className="text-center font-mono text-3xl tracking-[0.2em] tabular-nums">{digits}</p>;
	}

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap justify-center gap-x-4 gap-y-3">
				{symbols.map(({ char, name }, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length positional list, and one symbol can legitimately repeat
					<div key={`${i}-${char}`} className="flex flex-col items-center gap-0.5 w-14">
						<span className={large ? "text-4xl" : "text-3xl"} aria-hidden="true">
							{char}
						</span>
						<span className="text-[0.65rem] leading-tight text-muted-foreground text-center">
							{i18n._(name)}
						</span>
					</div>
				))}
			</div>
			{/* The fallback rail, for another device that has not updated yet. */}
			<p className="text-center text-[0.65rem] text-muted-foreground">
				<Trans>Older version on the other device? Compare this instead:</Trans>{" "}
				<span className="font-mono tabular-nums">{digits}</span>
			</p>
		</div>
	);
}
