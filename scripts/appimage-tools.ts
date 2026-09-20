// Every tool `tauri build` fetches while it makes an AppImage, pinned, and the one place they live.
//
// The bundler downloads five things mid-build (crates/tauri-bundler/.../appimage/linuxdeploy.rs):
// AppRun, linuxdeploy, the gtk and gstreamer plugins, and the AppImage packer. Each is a single
// point of failure in every Linux build, and two of them are worse than flaky: the plugin scripts
// come from the `master` branch of a repository, so whatever is on that branch at build time runs
// inside the bundle being signed. That is unpinned third-party code in a release artifact, which is
// the thing every action in .github/workflows is pinned by commit to avoid.
//
// The packer is worse still when it fails. Tauri does not stop: it falls back to an older built-in
// copy and leaves the cache empty, so appimage-portability.ts finds no packer and cannot repack,
// and repacking is what keeps a bundled libwayland-client out of the AppImage (issue #100). The
// choice in that moment is a dead build or quietly shipping the bug back, and it cost a release.
//
// So all five are pinned by digest and placed before the bundler looks. Tauri skips any tool
// already in its cache, so this is not a race with it: it simply never downloads. Versioned URLs
// where upstream publishes versions, commit URLs where it publishes a branch.

import { createHash } from "node:crypto";
import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Tool = {
	/** The name Tauri caches it under. `{arch}` is the bundler's, x86_64 or aarch64. */
	cache: string;
	url: string;
	/** By architecture, or `any` where the file is the same for both. */
	sha256: Record<string, string>;
};

const PACKER_VERSION = "1-alpha-20250213-1";

/** The gtk and gstreamer plugin scripts have no releases, so these pin a commit on master. */
const GTK_COMMIT = "b5eb8d05b4c0ed40107fe2158c5d8527f94568ef";
const GSTREAMER_COMMIT = "2a2e67491c32995a3f279ad0ecbe77abd512b42a";

const TOOLS: Tool[] = [
	{
		cache: "AppRun-{arch}",
		url: "https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-{arch}",
		sha256: {
			x86_64: "f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f",
			aarch64: "072f17c0895a85c490282fe5395c5007e5fc75da727e553b3b8fb680feb11578",
		},
	},
	{
		cache: "linuxdeploy-{arch}.AppImage",
		url: "https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy/linuxdeploy-{arch}.AppImage",
		sha256: {
			x86_64: "e762bea85c8eb0d4b3508d46e5c1f037f717d0f9303ae3b4aafc8b04991fa1ef",
			aarch64: "b12b5cc57bd0921e1f98d73f58aa364503bc1a27f54b7a69fd2870bce7fa2f55",
		},
	},
	{
		cache: "linuxdeploy-plugin-gtk.sh",
		url: `https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/${GTK_COMMIT}/linuxdeploy-plugin-gtk.sh`,
		sha256: { any: "cb379f9b0733e9ad9f8bd78f8c2fa038aef2478523bb7d4c8e64ff6a1ea3501a" },
	},
	{
		cache: "linuxdeploy-plugin-gstreamer.sh",
		url: `https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gstreamer/${GSTREAMER_COMMIT}/linuxdeploy-plugin-gstreamer.sh`,
		sha256: { any: "c107b49d84edbffc6ab226ed1007e0626a4f7aa2c3a36b7782bef62351d49e94" },
	},
	{
		cache: "linuxdeploy-plugin-appimage.AppImage",
		url: `https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/${PACKER_VERSION}/linuxdeploy-plugin-appimage-{arch}.AppImage`,
		sha256: {
			x86_64: "992d502a248e14ab185448ddf6f6e7d25558cb84d4623c354c3af350c25fccb3",
			aarch64: "83c292149274965a865dcd44c135cfca8ba28c6b7de3eb628d4b8b5f248af17c",
		},
	},
];

const toolsArch = (): string => (process.arch === "arm64" ? "aarch64" : "x86_64");

/** Where Tauri looks: `dirs::cache_dir()/tauri`. */
const toolsDir = (): string =>
	join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "tauri");

const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

const resolve = (tool: Tool, arch: string) => ({
	path: join(toolsDir(), tool.cache.replaceAll("{arch}", arch)),
	url: tool.url.replaceAll("{arch}", arch),
	want: tool.sha256[arch] ?? tool.sha256.any,
});

const PACKER = "linuxdeploy-plugin-appimage.AppImage";

/** The packer, which appimage-portability.ts runs directly to repack a bundle it has changed. */
export const packerPath = (): string => join(toolsDir(), PACKER);

/** Whether the packer in the cache is still the pinned build. Synchronous, for the repack step. */
export function packerMatchesPin(): boolean {
	const tool = TOOLS.find((t) => t.cache === PACKER);
	const path = packerPath();
	return !!tool && existsSync(path) && digest(path) === tool.sha256[toolsArch()];
}

/**
 * Executable, without assuming we own it. In the Linux container these can be baked into the image
 * and owned by root while the build runs as the invoking user, so a file can be runnable already
 * and chmod still be EPERM: asking first is the difference between that and a failed build.
 */
function makeRunnable(path: string): void {
	try {
		accessSync(path, constants.X_OK);
	} catch {
		chmodSync(path, 0o755);
	}
}

/**
 * Every pinned tool in Tauri's cache, executable, before the bundler runs.
 *
 * Digests are checked even when a file is already present: a truncated download from an interrupted
 * build is exactly the case where the packer's silent fallback would come back.
 */
export async function ensureTools(): Promise<void> {
	const arch = toolsArch();
	mkdirSync(toolsDir(), { recursive: true });
	const fetched: string[] = [];

	for (const tool of TOOLS) {
		const { path, url, want } = resolve(tool, arch);
		if (!want) throw new Error(`no pinned digest for ${tool.cache} on ${arch}`);
		if (existsSync(path) && digest(path) === want) {
			makeRunnable(path);
			continue;
		}

		for (let attempt = 1; ; attempt++) {
			try {
				const res = await fetch(url);
				if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
				writeFileSync(path, Buffer.from(await res.arrayBuffer()));
				break;
			} catch (error) {
				const why = error instanceof Error ? error.message : String(error);
				if (attempt === 3) throw new Error(`could not download ${url}: ${why}`);
				console.warn(`${tool.cache} download failed (${why}), retrying`);
			}
		}

		const got = digest(path);
		if (got !== want)
			throw new Error(
				`${tool.cache} does not match its pin:\n  want ${want}\n  got  ${got}\n  ${url}`,
			);
		makeRunnable(path);
		fetched.push(tool.cache.replaceAll("{arch}", arch));
	}

	console.log(
		fetched.length === 0
			? `AppImage tools: all ${TOOLS.length} already pinned in ${toolsDir()}`
			: `AppImage tools: fetched ${fetched.join(", ")}`,
	);
}
