// The AppImage packer, pinned, and the one place its version lives.
//
// `tauri build` fetches this from the linuxdeploy project's `continuous` tag while it bundles. That
// download is a single point of failure in every Linux build, and it fails in the worst way
// available: Tauri does not stop, it falls back to an older built-in packer and leaves its cache
// empty, so appimage-portability.ts finds no packer and cannot repack. Repacking is what keeps a
// bundled libwayland-client out of the AppImage, which is issue #100, so the choice in that moment
// is between a dead build and quietly shipping the bug back.
//
// Pinning it removes the choice. A dated tag rather than `continuous`, checked against its digest,
// so the bundle is built by the same bytes every time. The Linux image bakes it in (its Dockerfile
// takes the pin from here through build args); everywhere else, including CI and a local Linux
// build, `ensurePacker` puts it in place before the bundler looks.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PACKER_VERSION = "1-alpha-20250213-1";

/** Keyed by the name linuxdeploy publishes under, which is not Docker's name for the same thing. */
export const PACKER_SHA256: Record<string, string> = {
	x86_64: "992d502a248e14ab185448ddf6f6e7d25558cb84d4623c354c3af350c25fccb3",
	aarch64: "83c292149274965a865dcd44c135cfca8ba28c6b7de3eb628d4b8b5f248af17c",
};

export const packerArch = (): string => (process.arch === "arm64" ? "aarch64" : "x86_64");

/** Where Tauri looks: `dirs::cache_dir()/tauri`, under the name it caches the plugin as. */
export function packerPath(): string {
	const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
	return join(cache, "tauri", "linuxdeploy-plugin-appimage.AppImage");
}

export const packerUrl = (arch: string): string =>
	`https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/${PACKER_VERSION}/linuxdeploy-plugin-appimage-${arch}.AppImage`;

const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Whether what is in the cache now is still the pinned build. Synchronous, for the repack step. */
export function packerMatchesPin(): boolean {
	const path = packerPath();
	return existsSync(path) && digest(path) === PACKER_SHA256[packerArch()];
}

/**
 * The pinned packer, in Tauri's cache, executable. A no-op where it is already in place, which is
 * every build in the Linux container.
 *
 * The digest is checked even when the file is already there: a truncated download from an
 * interrupted build is exactly the case where the silent fallback would come back.
 */
export async function ensurePacker(): Promise<string> {
	const arch = packerArch();
	const want = PACKER_SHA256[arch];
	const path = packerPath();
	if (!want) throw new Error(`no pinned AppImage packer for ${arch}`);
	if (existsSync(path) && digest(path) === want) {
		chmodSync(path, 0o755);
		return path;
	}

	mkdirSync(dirname(path), { recursive: true });
	for (let attempt = 1; ; attempt++) {
		try {
			const res = await fetch(packerUrl(arch));
			if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
			writeFileSync(path, Buffer.from(await res.arrayBuffer()));
			break;
		} catch (error) {
			const why = error instanceof Error ? error.message : String(error);
			if (attempt === 3) throw new Error(`could not download the AppImage packer: ${why}`);
			console.warn(`AppImage packer download failed (${why}), retrying`);
		}
	}

	const got = digest(path);
	if (got !== want)
		throw new Error(
			`the AppImage packer does not match its pin:\n  want ${want}\n  got  ${got}\n  ${packerUrl(arch)}`,
		);
	chmodSync(path, 0o755);
	console.log(`AppImage packer ${PACKER_VERSION} (${arch}) ready`);
	return path;
}
