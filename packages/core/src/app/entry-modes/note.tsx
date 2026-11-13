import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { FileText } from "lucide-react";
import { useFormContext } from "react-hook-form";
import type { NoteEntryData } from "../../hooks/useVault";
import { TextArea } from "../components/ui/text-area";
import { TextField } from "../components/ui/text-field";
import { DetailNotes } from "./DetailField";
import type { EntryDetailBodyProps, EntryMode } from "./types";

interface NoteFormValues {
	name: string;
	notes: string;
}

/** First non-blank line of the body, for the list's secondary line. */
function firstLine(notes: string | undefined): string {
	const line = (notes ?? "").split("\n").find((l) => l.trim().length > 0);
	return line?.trim() ?? "";
}

function NoteFields() {
	const { register } = useFormContext<NoteFormValues>();
	const { t } = useLingui();
	return (
		<>
			<TextField label={t`Title`} type="text" {...register("name")} />
			<TextArea label={t`Content`} rows={8} autoGrow {...register("notes")} />
		</>
	);
}

function NoteDetail({ entry, copied, copy }: EntryDetailBodyProps) {
	const note = entry as NoteEntryData & { id: string };
	const { t } = useLingui();
	return <DetailNotes label={t`Content`} value={note.notes ?? ""} copied={copied} copy={copy} />;
}

/** EntryMode for secure notes. */
export const noteMode: EntryMode = {
	type: "note",
	get label() {
		return i18n._(msg`Secure note`);
	},
	get description() {
		return i18n._(msg`Store sensitive text`);
	},
	icon: FileText,

	emptyForm: () => ({ name: "", notes: "" }),

	toForm: (entry) => {
		const note = entry as NoteEntryData;
		return { name: note.name, notes: note.notes ?? "" };
	},

	toEntry: (values) => {
		const v = values as NoteFormValues;
		return { type: "note", name: v.name, notes: v.notes || undefined };
	},

	Fields: NoteFields,
	Detail: NoteDetail,

	row: (entry) => {
		const note = entry as NoteEntryData & { id: string };
		const preview = firstLine(note.notes);
		return {
			icon: FileText,
			secondary: preview || i18n._(msg`Secure note`),
			copyItems: note.notes ? [{ label: i18n._(msg`contents`), value: note.notes }] : [],
		};
	},

	// A note is its name and text, which every type's search covers.
	searchText: () => "",
};
