import { Trans, useLingui } from "@lingui/react/macro";
import { Tag, X } from "lucide-react";
import { type FocusEvent, type KeyboardEvent, useId, useRef, useState } from "react";
import { useFormContext } from "react-hook-form";
import { MAX_TAGS_PER_ENTRY, normalizeTags, tagKey } from "../../vault/tags";
import { Button } from "../components/ui/button";
import { FieldOutline } from "../components/ui/field-outline";
import { cn } from "../components/ui/utils";

/** Top-level form-values key for tags, shared by the editor and the form host. */
export const TAGS_NAME = "tags";

/** Seed the editor from a stored entry. Form-side shape is the stored one: a string array. */
export function tagsToForm(tags: string[] | undefined): string[] {
	return tags ?? [];
}

/** Collapse form values to stored tags; `undefined` when empty, as with custom fields. */
export function formToTags(values: unknown): string[] | undefined {
	return normalizeTags(values);
}

/** Searchable text contributed by an entry's tags. */
export function tagsSearchText(tags: string[] | undefined): string {
	return (tags ?? []).join(" ");
}

// Committing on comma as well as Enter matters more than it looks: people paste
// "work, banking" out of another manager, and Enter alone would store that as one tag.
const COMMIT_KEYS = new Set(["Enter", ",", "Tab"]);

interface TagsEditorProps {
	/** The vault's existing tags, offered as suggestions. Keeps spellings from drifting. */
	suggestions: string[];
}

/**
 * Tag editor, shared by every mode's form. Must render inside the host's <FormProvider>.
 *
 * The chips live INSIDE the field, on one line with the text cursor, the way every chip
 * input does. Deliberately not wrapped to a second line: a form field that grows a row
 * every few tags shoves everything below it down the page as you type. Overflow scrolls
 * horizontally instead, and because a chip that has scrolled out of sight is unreachable
 * by pointer, the arrow keys walk the chips and bring each one into view.
 */
export function TagsEditor({ suggestions }: TagsEditorProps) {
	const { watch, setValue } = useFormContext();
	const { t } = useLingui();
	const [draft, setDraft] = useState("");
	const inputId = useId();
	const hintId = useId();
	const fullId = useId();
	const menuId = useId();
	// Focus-WITHIN, not the input's own focus: arrowing into the menu blurs the input, and
	// a menu that closes the moment you reach it is no menu at all.
	const [focusWithin, setFocusWithin] = useState(false);
	// Escape puts the menu away without giving up the field; typing brings it back.
	const [dismissed, setDismissed] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const chipRefs = useRef<(HTMLButtonElement | null)[]>([]);
	const suggestionRefs = useRef<(HTMLButtonElement | null)[]>([]);
	// Adding and removing a chip are silent to a screen reader otherwise: the change
	// happens somewhere the caret isn't, and the input's own value goes back to empty.
	const [announcement, setAnnouncement] = useState("");

	const tags: string[] = watch(TAGS_NAME) ?? [];
	const full = tags.length >= MAX_TAGS_PER_ENTRY;

	const write = (next: string[]) => setValue(TAGS_NAME, next, { shouldDirty: true });

	const commit = (raw: string) => {
		const next = normalizeTags([...tags, raw]) ?? [];
		write(next);
		setDraft("");
		// Normalization can rewrite what was typed (hyphenated, deduped), so announce the
		// tag as it was actually stored rather than as it was entered.
		const added = next.length > tags.length ? next[next.length - 1] : raw;
		setAnnouncement(t`Added tag ${added}. ${next.length} tags.`);
		// The caret is at the far right of a row that just got wider; keep it in view.
		requestAnimationFrame(() =>
			inputRef.current?.scrollIntoView({ inline: "end", block: "nearest" }),
		);
	};

	// Focus lands on the neighbour rather than falling out of the field, so removing a run
	// of chips is repeated Backspace instead of re-aiming after every one.
	const removeAt = (index: number) => {
		const removed = tags[index] ?? "";
		write(tags.filter((_, i) => i !== index));
		setAnnouncement(t`Removed tag ${removed}. ${tags.length - 1} tags.`);
		const next = index >= tags.length - 1 ? index - 1 : index;
		requestAnimationFrame(() => {
			const chip = chipRefs.current[next];
			if (chip) chip.focus();
			else inputRef.current?.focus();
		});
	};

	const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (COMMIT_KEYS.has(e.key)) {
			// Tab with an empty draft is just a tab: don't trap focus in the field.
			if (e.key === "Tab" && !draft.trim()) return;
			e.preventDefault();
			if (draft.trim()) commit(draft);
			return;
		}
		// Into the suggestions. Tab can't serve here: with a draft in flight it commits
		// what was typed, which would take a half-typed "wo" over the "work" on offer and
		// leave the suggestion list unreachable by keyboard exactly when it is showing.
		if (e.key === "Escape" && menuOpen) {
			e.preventDefault();
			setDismissed(true);
			return;
		}
		if (e.key === "ArrowDown" && menuOpen) {
			e.preventDefault();
			suggestionRefs.current[0]?.focus();
			return;
		}
		if (draft) return;
		// Backspace on an empty draft peels off the last chip, as chip inputs do everywhere.
		if (e.key === "Backspace" && tags.length > 0) {
			removeAt(tags.length - 1);
			return;
		}
		// Step back into the chips. The input sits after them, so ArrowLeft is the way in.
		if (e.key === "ArrowLeft" && tags.length > 0) {
			e.preventDefault();
			chipRefs.current[tags.length - 1]?.focus();
		}
	};

	const onChipKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
		switch (e.key) {
			case "ArrowLeft":
				e.preventDefault();
				chipRefs.current[Math.max(0, index - 1)]?.focus();
				break;
			case "ArrowRight":
				e.preventDefault();
				// Past the last chip is the input, which is where typing should go anyway.
				if (index >= tags.length - 1) inputRef.current?.focus();
				else chipRefs.current[index + 1]?.focus();
				break;
			case "Backspace":
			case "Delete":
				e.preventDefault();
				removeAt(index);
				break;
			case "Escape":
				e.preventDefault();
				inputRef.current?.focus();
				break;
			default:
				// Any actual character means they meant to type a tag, not walk the chips.
				if (e.key.length === 1) inputRef.current?.focus();
		}
	};

	// Prefix-matched, and already-applied tags are dropped: a suggestion that does nothing
	// when clicked is worse than no suggestion.
	const applied = new Set(tags.map(tagKey));
	const draftKey = tagKey(draft);
	const offered = full
		? []
		: suggestions
				.filter((s) => !applied.has(tagKey(s)) && tagKey(s).startsWith(draftKey))
				.slice(0, 8);
	// Open on focus, not only once something is typed: the whole point is to show what the
	// vault already uses before the user invents a second spelling of one of them.
	const menuOpen = focusWithin && !dismissed && offered.length > 0;

	// Focus tracking rides the input and the menu items rather than a wrapper: a div with
	// focus handlers is not a control, and biome is right to say so.
	const onEnter = () => {
		setFocusWithin(true);
		setDismissed(false);
	};
	const onLeave = (e: FocusEvent<HTMLElement>) => {
		// Moving between the input and a menu item is not leaving the field, and must not
		// commit a half-typed draft over the suggestion being reached for.
		if (wrapRef.current?.contains(e.relatedTarget as Node | null)) return;
		setFocusWithin(false);
		setDismissed(false);
		// Commit on the way out, so a typed-but-unconfirmed tag isn't silently dropped by
		// pressing Save.
		if (draft.trim()) commit(draft);
	};

	const onSuggestionKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				suggestionRefs.current[Math.min(offered.length - 1, index + 1)]?.focus();
				break;
			case "ArrowUp":
				e.preventDefault();
				// Up from the first item returns to the query, not a wrap to the bottom.
				if (index === 0) inputRef.current?.focus();
				else suggestionRefs.current[index - 1]?.focus();
				break;
			case "Escape":
				e.preventDefault();
				setDismissed(true);
				inputRef.current?.focus();
				break;
			default:
				break;
		}
	};

	return (
		<div>
			{/* mb-4 rather than the mb-2 a plain field group uses: this field's label straddles
			    its top border and so rises above it, eating most of the gap. Measured from the
			    "Add a tag" text, not the border, mb-2 left about three pixels. */}
			<div className="flex items-center gap-1.5 mb-4">
				<Tag className="w-3.5 h-3.5 text-muted-foreground" />
				<span className="block text-sm">
					<Trans>Tags</Trans>
				</span>
			</div>

			<div ref={wrapRef} className="group relative">
				<div
					className={cn(
						// py-2.5 with min-h-11 matches a plain TextField's height, and the label
						// is on the border now rather than eating into the top padding.
						"flex min-h-11 w-full items-center gap-1.5 overflow-x-auto px-3 py-2.5",
						// One line, always. Chips keep their width and the row scrolls.
						"flex-nowrap touch-pan-x [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
						full ? "cursor-not-allowed" : "cursor-text",
					)}
				>
					{tags.map((tag, index) => (
						<span
							key={tagKey(tag)}
							className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/50 bg-muted/40 py-0.5 pl-2.5 pr-1 text-xs"
						>
							{tag}
							<Button
								ref={(el) => {
									chipRefs.current[index] = el;
								}}
								variant="ghost"
								size="none"
								tabIndex={-1}
								onClick={() => removeAt(index)}
								onKeyDown={(e) => onChipKeyDown(e, index)}
								// A chip reached by keyboard may be scrolled out of sight.
								onFocus={(e) =>
									e.currentTarget.scrollIntoView({ inline: "nearest", block: "nearest" })
								}
								className="rounded-full p-0.5 hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive"
								aria-label={t`Remove tag ${tag}`}
							>
								<X className="w-3 h-3" />
							</Button>
						</span>
					))}

					{/* flex-1: the input fills everything right of the last chip, so clicking
					    the empty part of the field lands on it without a focus proxy. */}
					<input
						ref={inputRef}
						id={inputId}
						type="text"
						autoComplete="off"
						// readOnly, not disabled: a disabled input leaves the tab order, so a
						// keyboard user reaches a field that silently isn't there and never hears
						// why. This one still takes focus and carries its own explanation.
						readOnly={full}
						aria-describedby={full ? `${hintId} ${fullId}` : hintId}
						value={draft}
						onChange={(e) => {
							setDismissed(false);
							setDraft(e.target.value);
						}}
						onKeyDown={onInputKeyDown}
						onFocus={onEnter}
						onBlur={onLeave}
						// combobox, so aria-expanded/aria-controls are valid on the input itself:
						// it is a text field that owns a popup of choices.
						role="combobox"
						aria-haspopup="menu"
						aria-expanded={menuOpen}
						aria-controls={menuOpen ? menuId : undefined}
						className={cn(
							"min-w-24 flex-1 bg-transparent text-sm text-foreground outline-none",
							full && "cursor-not-allowed",
						)}
					/>
				</div>

				<FieldOutline
					label={t`Add a tag`}
					// Always open. A field holding chips is never visually empty, so a label that
					// floats on focus would only ever animate out of the way of content already
					// there, and on the way it lands on the first chip.
					notch="always"
					// The input is nested in the scrolling row, so it is not this outline's peer.
					className="group-focus-within:border-primary"
				/>
				{/* Sits ON the top border, centred in the notch the legend cuts, at the
				    legend's own font size so the gap and the text are the same width. No
				    transition: it has nowhere to travel from. */}
				<label
					htmlFor={inputId}
					className={cn(
						"pointer-events-none absolute left-3 top-0 -translate-y-1/2 text-[0.66rem]",
						"text-muted-foreground group-focus-within:text-primary",
					)}
				>
					{t`Add a tag`}
				</label>

				{menuOpen && (
					// Overlays what follows rather than displacing it, so the form below doesn't
					// jump every time the field takes focus. Same panel as the search bar's tag
					// menu and the app's DropdownMenu.
					<div
						id={menuId}
						role="menu"
						aria-label={t`Existing tags`}
						className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-lg border border-border/50 bg-card shadow-xl shadow-black/10"
					>
						{/* Capped and scrolled on the inner element so the panel keeps its
						    rounded corners while the list clips. */}
						<div className="max-h-[125px] overflow-y-auto overscroll-contain">
							{offered.map((tag, index) => (
								<button
									key={tagKey(tag)}
									ref={(el) => {
										suggestionRefs.current[index] = el;
									}}
									type="button"
									role="menuitem"
									// Keep focus in the input: a plain click would blur it first, and
									// blur commits the draft, so picking "Finance" after typing "fin"
									// would store "fin" instead.
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => {
										commit(tag);
										inputRef.current?.focus();
									}}
									onKeyDown={(e) => onSuggestionKeyDown(e, index)}
									onFocus={onEnter}
									onBlur={onLeave}
									className="flex w-full items-center gap-2 border-b border-border/30 px-3 py-2 text-left text-xs transition-colors last:border-b-0 hover:bg-primary/5 focus-visible:bg-primary/5 focus-visible:outline-none"
								>
									<Tag className="w-3 h-3 shrink-0 text-muted-foreground" />
									{tag}
								</button>
							))}
						</div>
					</div>
				)}
			</div>

			{/* The mechanics are obvious by sight (chips with an x, a caret after them) and
			    invisible to a screen reader, which needs to be told the keys exist. */}
			<p id={hintId} className="sr-only">
				<Trans>
					Press Enter or comma to add a tag. Press the left arrow to move into the tags you have
					already added, then Backspace to remove one. Press the down arrow for suggestions.
				</Trans>
			</p>
			<p role="status" aria-live="polite" className="sr-only">
				{announcement}
			</p>

			{full && (
				<p id={fullId} className="mt-1 text-xs text-muted-foreground">
					<Trans>This entry has as many tags as it can hold.</Trans>
				</p>
			)}
		</div>
	);
}

/** Read-only tag chips for an entry's detail view; each one filters the list by that tag. */
export function TagsDetail({ tags, onSelect }: { tags: string[]; onSelect(tag: string): void }) {
	const { t } = useLingui();
	if (tags.length === 0) return null;
	return (
		<div className="flex flex-wrap gap-1.5">
			{tags.map((tag) => (
				<Button
					key={tagKey(tag)}
					variant="link"
					size="none"
					onClick={() => onSelect(tag)}
					aria-label={t`Show everything tagged ${tag}`}
					className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:border-border"
				>
					<Tag className="w-3 h-3 shrink-0" />
					{tag}
				</Button>
			))}
		</div>
	);
}
