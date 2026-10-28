// The self-hosted server's BodyStore: one file per body under a root directory, each key segment
// hex-encoded. Writes go to a sibling temp file and are renamed into place only once complete (and,
// with a sha256, verified), so a reader never sees a partial body.

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type Dirent } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type BodyStore, HashMismatchError } from "../core/bodies.ts";

const SEGMENT = /^[A-Za-z0-9_-]+$/;
const TEMP = ".tmp-";

export function diskBodies(root: string): BodyStore {
	function pathOf(key: string): string {
		const segments = key.split("/");
		if (segments.length === 0 || !segments.every((s) => SEGMENT.test(s))) {
			throw new Error("invalid body key");
		}
		// Hex on disk: ids are case-sensitive and macOS and Windows filesystems are not, so two ids
		// differing only in case would otherwise be one file.
		return join(root, ...segments.map((s) => Buffer.from(s, "utf8").toString("hex")));
	}

	return {
		async put(key, body, opts) {
			const path = pathOf(key);
			await mkdir(dirname(path), { recursive: true });
			const temp = `${path}${TEMP}${randomUUID()}`;
			const hash = createHash("sha256");
			const source =
				body instanceof Uint8Array ? Readable.from([body]) : Readable.fromWeb(body as never);
			const hashing = new Transform({
				transform(chunk, _enc, done) {
					hash.update(chunk);
					done(null, chunk);
				},
			});
			try {
				await pipeline(source, hashing, createWriteStream(temp));
				if (opts?.sha256 && hash.digest("hex") !== opts.sha256) throw new HashMismatchError();
				await rename(temp, path);
			} catch (err) {
				await rm(temp, { force: true });
				throw err;
			}
		},

		async get(key) {
			const path = pathOf(key);
			try {
				const { size } = await stat(path);
				return { body: Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>, size };
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw err;
			}
		},

		async delete(key) {
			await rm(pathOf(key), { force: true });
		},

		async *keys() {
			let entries: Dirent[];
			try {
				entries = await readdir(root, { recursive: true, withFileTypes: true });
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
				throw err;
			}
			for (const entry of entries) {
				if (!entry.isFile() || entry.name.includes(TEMP)) continue;
				const full = join(entry.parentPath, entry.name);
				const { mtimeMs } = await stat(full);
				const key = relative(root, full)
					.split(sep)
					.map((s) => Buffer.from(s, "hex").toString("utf8"))
					.join("/");
				yield { key, modifiedAt: mtimeMs };
			}
		},
	};
}
