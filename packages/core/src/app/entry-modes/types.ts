import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import type { FieldValues } from "react-hook-form";
import type { BreachStatus, Entry, EntryData, EntryType } from "../../hooks/useVault";

export interface EntryFieldsProps {
	initialBreach?: BreachStatus;
}

export interface EntryDetailBodyProps {
	entry: Entry;
	copied: string | null;
	copy: (label: string, value: string) => void;
}

export interface EntryRowView {
	// Avatar icon (also used in the detail header). Shown unless `initials` is set.
	icon: LucideIcon;
	initials?: string;
	secondary: string;
	copyItems: { label: string; value: string }[];
	leaked?: boolean;
}

export interface EntryMode {
	type: EntryType;
	// Human label, e.g. "Password". Used in the add-menu and form/detail headers.
	label: string;
	// Add-menu subtitle, e.g. "Credit or debit card".
	description: string;
	icon: LucideIcon;

	emptyForm(ctx: { defaultUrl?: string }): FieldValues;
	// Seed form values from an existing entry (edit / pop-out restore).
	toForm(entry: EntryData): FieldValues;
	// Map submitted form values into a persisted entry payload.
	toEntry(values: FieldValues): EntryData;

	// Inputs-only form body (chrome + submit live in the host).
	Fields: ComponentType<EntryFieldsProps>;
	// Fields-only detail body (chrome + header + footer live in the host).
	Detail: ComponentType<EntryDetailBodyProps>;

	detailSubtitle?(entry: Entry): string | undefined;
	detailAlert?(entry: Entry): { title: string; body: string } | null;

	// Vault-list row projection + the text the search box matches against.
	row(entry: Entry): EntryRowView;
	searchText(entry: Entry): string;
}
