import { execFileSync } from "node:child_process";

/**
 * Why `docker version` failed, in the user's terms.
 *
 * Worth its own function because the obvious message is wrong in the most common case. A
 * permission-denied socket is neither "not installed" nor "not running": it is a user who has been
 * added to the `docker` group in a shell that started before the group existed, so `id -Gn` does
 * not list it yet and never will until they log out. Told "docker is not running" they go and
 * check the daemon, find it running, and are stuck.
 *
 * Returns null when docker works.
 */
export function dockerProblem(): string | null {
	try {
		execFileSync("docker", ["version"], { stdio: "pipe" });
		return null;
	} catch (e) {
		const err = e as { code?: string; stderr?: Buffer };
		if (err.code === "ENOENT") return "docker is not installed, or not on PATH.";

		const stderr = err.stderr?.toString() ?? "";
		if (/permission denied/i.test(stderr)) {
			return (
				"docker is installed and running, but this shell cannot reach its socket.\n" +
				"Almost always a stale group: you are in the `docker` group but this shell started\n" +
				"before that, so it does not know. Check with `id -Gn | grep docker`.\n" +
				"  fix now:        newgrp docker\n" +
				"  one-off:        sg docker -c '<command>'\n" +
				"  fix properly:   log out and back in"
			);
		}
		if (/cannot connect|daemon running|refused/i.test(stderr)) {
			return "the docker daemon is not running. Start it with `systemctl start docker`.";
		}
		return `docker is not usable: ${stderr.trim().split("\n")[0] || "unknown error"}`;
	}
}
