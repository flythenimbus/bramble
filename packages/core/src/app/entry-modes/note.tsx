import { FileText } from "lucide-react";
import { useFormContext } from "react-hook-form";
import type { NoteEntryData } from "../../hooks/useVault";
import { TextArea } from "../components/ui/text-area";
import { TextField } from "../components/ui/text-field";
import type { EntryDetailBodyProps, EntryMode } from "./types";

export interface NoteFormValues {
	name: string;
	notes: string;
}

function firstLine(notes: string | undefined): string {
	const line = (notes ?? "").split("\n").find((l) => l.trim().length > 0);
	return line?.trim() ?? "";
}

function NoteFields() {
	const { register } = useFormContext<NoteFormValues>();
	return (
		<>
			<TextField label="Title" type="text" {...register("name")} />
			<TextArea label="Content" rows={8} {...register("notes")} />
		</>
	);
}

function NoteDetail({ entry }: EntryDetailBodyProps) {
	const note = entry as NoteEntryData & { id: string };
	return (
		<div className="space-y-1.5">
			<p className="text-xs text-muted-foreground">Content</p>
			<p className="text-sm whitespace-pre-wrap">{note.notes || "—"}</p>
		</div>
	);
}

export const noteMode: EntryMode = {
	type: "note",
	label: "Secure note",
	description: "Store sensitive text",
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
			secondary: preview || "Secure note",
			copyItems: note.notes ? [{ label: "contents", value: note.notes }] : [],
		};
	},

	searchText: (entry) => {
		const note = entry as NoteEntryData;
		return `${note.name} ${note.notes ?? ""}`.toLowerCase();
	},
};
