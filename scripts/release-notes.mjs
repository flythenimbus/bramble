// Release notes: a short human summary drafted from the commit range, then edited by hand before
// it publishes.
//
// The commit log is written for us, not for the people reading a release page. "hold the desktop
// link open so sync can arrive unprompted" is a good commit subject and a poor release note. So
// the subjects become a draft here, and the draft opens in $EDITOR: the model does the tedious
// part, a person does the part that needs judgement.
//
// The model only ever sees the subjects and is told not to go beyond them, because a release note
// that overclaims is worse than a dull one, especially for a password manager. Everything it wrote
// is still checkable against the full list, which is kept underneath, collapsed.
//
// No model reachable, or not a terminal (CI): fall back to the grouped list, unedited. A release
// must never block on this.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chat, modelInfo } from "./i18n/ollama.mjs";

const SYSTEM =
	"You write release notes for Bramble, an open-source password manager. You are given the " +
	"commit subjects for one release. Write what a user would want to know.\n\n" +
	"Rules:\n" +
	"- At most five bullets, one sentence each. Fewer is better. If one change matters more than " +
	"the rest, lead with it as a short paragraph and let the bullets carry the remainder.\n" +
	"- Say what changed for the person using the app, not how it was built. Skip refactors, " +
	"tests, CI, dependency bumps and anything internal.\n" +
	"- Claim nothing that is not in the subjects you were given. Do not guess at motivation, " +
	"do not add benefits, do not describe features that are merely implied.\n" +
	"- Plain language. No marketing, no exclamation marks, no emoji, no em dashes.\n" +
	"- Write prose, not commit subjects: full sentences, capitalised, ending in a full stop.\n" +
	"- Output markdown with no heading; the heading is added around you.";

/** Conventional-commit subjects, grouped the way the log already implies. Also the fallback. */
export function groupSubjects(subjects) {
	const sections = [
		["feat", "### Features"],
		["fix", "### Bug Fixes"],
		["perf", "### Performance"],
		["refactor", "### Refactors"],
		["docs", "### Documentation"],
	];
	const groups = new Map();
	const other = [];
	for (const s of subjects) {
		const m = s.match(/^(\w+)(?:\([^)]*\))?!?:\s*(.+)/);
		const heading = sections.find(([t]) => t === m?.[1])?.[1];
		if (heading) groups.set(heading, [...(groups.get(heading) ?? []), m?.[2] ?? s]);
		else other.push(s);
	}
	let body = "";
	for (const [, heading] of sections) {
		const items = groups.get(heading);
		if (items) body += `${heading}\n\n${items.map((d) => `- ${d}`).join("\n")}\n\n`;
	}
	if (other.length) body += `### Other\n\n${other.map((d) => `- ${d}`).join("\n")}\n\n`;
	return body.trim();
}

/** The subjects a user could plausibly care about, which is what the model is asked to summarise. */
function userFacing(subjects) {
	return subjects.filter((s) => /^(feat|fix|perf)(\(|!|:)/.test(s));
}

async function draft(subjects) {
	const interesting = userFacing(subjects);
	if (interesting.length === 0) return null;
	const answer = await chat(SYSTEM, interesting.map((s) => `- ${s}`).join("\n"));
	return answer.trim() || null;
}

/**
 * Draft, then open in $EDITOR. Returns the body to publish.
 *
 * `full` is appended collapsed, so nothing the summary leaves out is lost, and anyone who wants
 * the real list is one click away from it.
 */
export async function composeNotes({ subjects, footer, edit = true }) {
	const full = groupSubjects(subjects);
	let summary = null;
	try {
		summary = await draft(subjects);
		if (summary) console.log(`\nrelease notes drafted by ${modelInfo}`);
	} catch (e) {
		// Never fatal. A release that cannot go out because a model was unreachable is a worse
		// failure than a release with a plain changelog.
		console.error(`note: could not draft release notes (${e.message}); using the commit list.`);
	}

	const body =
		[
			summary,
			full && `<details>\n<summary>All changes (${subjects.length})</summary>\n\n${full}\n</details>`,
			footer,
		]
			.filter(Boolean)
			.join("\n\n") || "_No notable changes._";

	if (!edit || !process.stdin.isTTY) return body;
	return openInEditor(body);
}

function openInEditor(body) {
	const editor = process.env.VISUAL ?? process.env.EDITOR;
	if (!editor) {
		console.error("note: no $EDITOR set, publishing the draft as it is.");
		return body;
	}
	const dir = mkdtempSync(join(tmpdir(), "bramble-notes-"));
	const file = join(dir, "RELEASE_NOTES.md");
	writeFileSync(file, body);
	try {
		console.log("\nEditing the release notes. Save and quit to publish; the file is markdown.\n");
		execFileSync(editor, [file], { stdio: "inherit", shell: true });
		return readFileSync(file, "utf8").trim() || body;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
