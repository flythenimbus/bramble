// A file's MIME type from its name, for a file that arrives without one: picked through a
// native dialog, or carried in a KeePass database, which keeps only the name.

/** Enough to hand the right type on; an OS opener goes by the extension anyway. */
const MIME_BY_EXT: Record<string, string> = {
	pdf: "application/pdf",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	heic: "image/heic",
	txt: "text/plain",
	md: "text/markdown",
	csv: "text/csv",
	json: "application/json",
	zip: "application/zip",
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	key: "application/octet-stream",
	pem: "application/x-pem-file",
};

export function mimeFor(name: string): string {
	const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
	return MIME_BY_EXT[ext] ?? "application/octet-stream";
}
