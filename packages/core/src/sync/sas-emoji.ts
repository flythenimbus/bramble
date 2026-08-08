// The emoji alphabet for the pairing SAS: 64 symbols, so each one carries exactly 6 bits.
//
// This is the set from the Matrix spec's SAS verification (Apache 2.0), reused rather than
// curated fresh. It was picked so no two entries are easy to confuse at small sizes, and so the
// codepoints render in the fonts that ship with every platform. Both properties are hard to get
// right by eye and expensive to get wrong: a confusable pair means a user waves through a
// mismatch, which is the one thing the SAS exists to prevent.
//
// ORDER IS A WIRE FORMAT. An index is derived on one device and displayed on another, so moving
// an entry means two devices disagree about what they are comparing. Append nothing, resort
// nothing; the table is 64 long forever because 6 bits addresses 0..63.
//
// Names live with the UI (see app/components/SasDisplay), not here. This module is imported by
// the SAS derivation, which is crypto and reached from every platform's test config; pulling a
// Lingui macro into that path makes the transform a dependency of code that has no text in it.

/** How many symbols one SAS shows: 7 x 6 bits = 42 bits, above the 12-digit form's ~40. */
export const SAS_EMOJI_LEN = 7;

export const SAS_EMOJI: readonly string[] = [
	"🐶",
	"🐱",
	"🦁",
	"🐎",
	"🦄",
	"🐷",
	"🐘",
	"🐰",
	"🐼",
	"🐓",
	"🐧",
	"🐢",
	"🐟",
	"🐙",
	"🦋",
	"🌷",
	"🌳",
	"🌵",
	"🍄",
	"🌏",
	"🌙",
	"☁️",
	"🔥",
	"🍌",
	"🍎",
	"🍓",
	"🌽",
	"🍕",
	"🎂",
	"❤️",
	"🙂",
	"🤖",
	"🎩",
	"👓",
	"🔧",
	"🎅",
	"👍",
	"☂️",
	"⌛",
	"⏰",
	"🎁",
	"💡",
	"📖",
	"✏️",
	"📎",
	"✂️",
	"🔒",
	"🔑",
	"🔨",
	"☎️",
	"🏁",
	"🚂",
	"🚲",
	"✈️",
	"🚀",
	"🏆",
	"⚽",
	"🎸",
	"🎺",
	"🔔",
	"⚓",
	"🎧",
	"📁",
	"📌",
];
