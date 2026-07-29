import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import type { FieldValues } from "react-hook-form";
import type { BreachStatus, Entry, EntryData, EntryType } from "../../hooks/useVault";

/** Props for a mode's form-body component; the host owns the form context and chrome. */
export interface EntryFieldsProps {
	// Login-only: flags a known-breached initial password (derived HIBP state).
	initialBreach?: BreachStatus;
}

/** Props for a mode's detail-body component; the host owns chrome, header, footer, clipboard. */
export interface EntryDetailBodyProps {
	entry: Entry;
	// Label of the most recently copied field, or null.
	copied: string | null;
	copy: (label: string, value: string) => void;
}

/**
 * One entry in the row's copy menu.
 *
 * `value` may be a thunk, resolved when the user clicks rather than when the row is projected.
 * That is what lets a time-based value belong here: a TOTP code baked in at projection time goes
 * stale within its 30-second step, and the list is virtualized, so rows are not re-projected on
 * any schedule that would keep it fresh.
 */
export interface CopyItem {
	label: string;
	value: string | (() => string);
}

/** How a mode projects an entry into a vault-list row, keeping the list type-agnostic. */
export interface EntryRowView {
	// Avatar icon (also used in the detail header). Shown unless `initials` is set.
	icon: LucideIcon;
	// When present, the avatar shows these characters instead of `icon`.
	initials?: string;
	// Secondary line under the name (username, masked card number, ...).
	secondary: string;
	// Quick-copy actions for the row's copy menu. Empty hides the menu.
	copyItems: CopyItem[];
	// Login-only: drives the "Breached" badge.
	leaked?: boolean;
}

/**
 * Self-contained description of one entry kind. Registering a descriptor in
 * app/entry-modes/index is the only step to add a new mode: form, detail, list,
 * add-menu, and routing all read from here.
 */
export interface EntryMode {
	type: EntryType;
	// Human label, e.g. "Login". Used in the add-menu and headers.
	label: string;
	// Add-menu subtitle, e.g. "Credit or debit card".
	description: string;
	icon: LucideIcon;

	// Build blank form values for a brand-new entry.
	emptyForm(ctx: { defaultUrl?: string }): FieldValues;
	// Seed form values from an existing entry (edit / pop-out restore).
	toForm(entry: EntryData): FieldValues;
	// Map submitted form values into a persisted entry payload.
	toEntry(values: FieldValues): EntryData;

	// Inputs-only form body (chrome + submit live in the host).
	Fields: ComponentType<EntryFieldsProps>;
	// Fields-only detail body (chrome + header + footer live in the host).
	Detail: ComponentType<EntryDetailBodyProps>;

	// Detail-header subtitle; undefined hides it.
	detailSubtitle?(entry: Entry): string | undefined;
	// Optional warning banner above the detail card.
	detailAlert?(entry: Entry): { title: string; body: string } | null;

	// Vault-list row projection + the text the search box matches against.
	row(entry: Entry): EntryRowView;
	searchText(entry: Entry): string;
}
