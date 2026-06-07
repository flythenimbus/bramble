import type { ImportResult } from "../../../../import";
import { getEntryMode } from "../../../entry-modes";

export function countLine(result: ImportResult): string {
	const parts = Object.entries(result.byType).map(([type, n]) => {
		const label = getEntryMode(type).label;
		return `${n} ${label}${n === 1 ? "" : "s"}`;
	});
	return parts.join(" · ");
}
