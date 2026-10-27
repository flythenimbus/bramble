import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

// The compose servers the BRAMBLE_IT specs run against (`docker compose up -d`), and how a spec
// reads what landed there: with `mc`, a different S3 client from ours. Verifying our uploads by
// asking our own signer to list them would prove the two agree, not that either is right.

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const S3 = {
	endpoint: process.env.BRAMBLE_IT_S3 ?? "http://localhost:9000",
	bucket: process.env.BRAMBLE_IT_S3_BUCKET ?? "bramble-test",
	key: process.env.BRAMBLE_IT_S3_KEY ?? "bramble",
	secret: process.env.BRAMBLE_IT_S3_SECRET ?? "bramble-test-secret",
	region: "us-east-1",
};

/** Run `mc` inside the compose network, where it reaches MinIO by name. */
export function mc(command: string): Buffer {
	const script = `mc alias set local http://minio:9000 ${S3.key} ${S3.secret} > /dev/null && ${command}`;
	return execFileSync(
		"docker",
		["compose", "run", "--rm", "-T", "--entrypoint", "sh", "minio-init", "-c", script],
		{ cwd: ROOT, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 512 * 1024 * 1024 },
	);
}

/** The object keys under `prefix`, relative to it, as `mc` lists them. */
export function s3Keys(prefix: string): string[] {
	return (
		mc(`mc ls --recursive local/${S3.bucket}/${prefix}/ || true`)
			.toString("utf8")
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			// `[date] size STANDARD some/key`: the key is the last field.
			.map((line) => line.split(/\s+/).at(-1) as string)
			.filter((key) => key && !key.endsWith("/"))
	);
}

/** Fill the Backups panel's S3 form for the compose MinIO, writing under `prefix`. */
export async function fillS3Form(popup: Page, prefix: string): Promise<void> {
	await popup.getByRole("button", { name: /Other S3-compatible/i }).click();
	await popup.getByLabel("Bucket").fill(S3.bucket);
	await popup.getByLabel("Access key ID").fill(S3.key);
	await popup.getByLabel("Secret access key").fill(S3.secret);
	// Already open for the generic S3 tile, which has no endpoint to default to. Clicking it
	// unconditionally would close it, and the fields inside would never be found.
	const advanced = popup.getByRole("button", { name: "Advanced" });
	if ((await advanced.getAttribute("aria-expanded")) !== "true") await advanced.click();
	await popup.getByLabel("Endpoint").fill(S3.endpoint);
	await popup.getByLabel("Region").fill(S3.region);
	await popup.getByLabel(/Path prefix/i).fill(prefix);
}
