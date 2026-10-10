import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";

export interface EncryptedRecord {
	iv: string;
	ciphertext: string;
}

export async function drainHandoff(
	file: string,
	iosBridge: {
		consume(): Promise<{ pending: EncryptedRecord[] }>;
		restore(o: { keep: EncryptedRecord[] }): Promise<void>;
	},
): Promise<{
	records: EncryptedRecord[];
	reclaim: (leftovers: EncryptedRecord[]) => Promise<void>;
}> {
	if (Capacitor.getPlatform() === "ios") {
		const pending =
			(await iosBridge.consume().catch(() => ({ pending: [] as EncryptedRecord[] })))?.pending ??
			[];
		return {
			records: pending,
			reclaim: async (keep) => {
				if (keep.length) await iosBridge.restore({ keep }).catch(() => {});
			},
		};
	}
	try {
		await Filesystem.stat({ path: file, directory: Directory.Data });
	} catch {
		return { records: [], reclaim: async () => {} };
	}
	try {
		const r = await Filesystem.readFile({
			path: file,
			directory: Directory.Data,
			encoding: Encoding.UTF8,
		});
		await Filesystem.deleteFile({ path: file, directory: Directory.Data }).catch(() => {});
		const records = JSON.parse(r.data as string);
		return {
			records: Array.isArray(records) ? records : [],
			reclaim: async (keep) => {
				if (!keep.length) return;
				const current = await Filesystem.readFile({
					path: file,
					directory: Directory.Data,
					encoding: Encoding.UTF8,
				})
					.then((res) =>
						Array.isArray(JSON.parse(res.data as string)) ? JSON.parse(res.data as string) : [],
					)
					.catch(() => []);
				const merged = [...keep, ...(current as EncryptedRecord[])];
				await Filesystem.writeFile({
					path: file,
					directory: Directory.Data,
					data: JSON.stringify(merged),
					encoding: Encoding.UTF8,
				}).catch(() => {});
			},
		};
	} catch {
		await Filesystem.deleteFile({ path: file, directory: Directory.Data }).catch(() => {});
		return { records: [], reclaim: async () => {} };
	}
}
