import type { FileTransferStatus } from "./transport/blob-sync";

// Where an in-process host's files adapter asks why a file hasn't arrived. The sync module that
// runs the file session answers here and the adapter asks here, since importing each other would
// be a cycle. Desktop and mobile; the extension's session runs in another context.

type Answer = (vaultId: string, hashes: string[]) => Promise<Record<string, FileTransferStatus>>;
let answer: Answer | null = null;

export function answerBlobStatus(fn: Answer): void {
	answer = fn;
}

export function askBlobStatus(
	vaultId: string,
	hashes: string[],
): Promise<Record<string, FileTransferStatus>> {
	return answer ? answer(vaultId, hashes) : Promise.resolve({});
}
