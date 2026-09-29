import type { PendingAssociation } from "../adapters/shell";
import type { Entry, EntryData, LoginEntry } from "../hooks/useVault";
import { appIdFromUri, extractHostname } from "./autofill-index";

export interface AssociationUpdate {
	entryId: string;
	data: EntryData;
	added: string[];
	entryName: string;
}

function targetKey(url: string): string {
	const s = url.trim().toLowerCase();
	const app = appIdFromUri(s);
	if (app) return `app:${app.toLowerCase()}`;
	const host = extractHostname(s).toLowerCase();
	return host ? `web:${host}` : `raw:${s}`;
}

export function planAssociationUpdates(
	entries: Entry[],
	activeVaultId: string | null | undefined,
	pending: PendingAssociation[],
): AssociationUpdate[] {
	if (pending.length === 0) return [];
	const scope = activeVaultId ?? "";
	const byId = new Map(entries.map((e) => [e.id, e]));
	const acc = new Map<string, { added: string[]; seen: Set<string> }>();
	for (const assoc of pending) {
		if (assoc.vaultId !== scope || !assoc.url) continue;
		const entry = byId.get(assoc.entryId);
		if (entry?.type !== "login" || entry.archivedAt !== undefined) continue;
		let plan = acc.get(assoc.entryId);
		if (!plan) {
			plan = { added: [], seen: new Set(entry.urls.map(targetKey)) };
			acc.set(assoc.entryId, plan);
		}
		const key = targetKey(assoc.url);
		if (plan.seen.has(key)) continue;
		plan.seen.add(key);
		plan.added.push(assoc.url);
	}
	const out: AssociationUpdate[] = [];
	for (const [entryId, { added }] of acc) {
		if (added.length === 0) continue;
		const entry = byId.get(entryId) as LoginEntry;
		const { id: _id, ...data } = entry;
		out.push({
			entryId,
			data: { ...data, urls: [...entry.urls, ...added] },
			added,
			entryName: entry.name,
		});
	}
	return out;
}
