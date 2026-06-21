#!/usr/bin/env node
// Runs `cap` for Android with JAVA_HOME pointed at a JDK 21. The Capacitor Android
// plugins declare a Java 21 toolchain, but the system default here is often 17, so a
// bare `cap run android` fails with "Cannot find a Java installation ... matching
// {languageVersion=21}". Resolution order: an already-21 JAVA_HOME, `java_home -v 21`,
// then Android Studio's bundled JBR. Setting the env in JS (not inline in the npm
// script) sidesteps the space in "Android Studio.app".
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function isJdk21(home) {
	try {
		return /JAVA_VERSION="?21/.test(readFileSync(join(home, "release"), "utf8"));
	} catch {
		return false;
	}
}

function resolveJava21() {
	if (process.env.JAVA_HOME && isJdk21(process.env.JAVA_HOME)) return process.env.JAVA_HOME;
	// `java_home -v 21` falls back to the newest JDK when 21 is absent, so verify the
	// version rather than trusting the path.
	const jh = spawnSync("/usr/libexec/java_home", ["-v", "21"], { encoding: "utf8" });
	if (jh.status === 0) {
		const p = jh.stdout.trim();
		if (p && isJdk21(p)) return p;
	}
	const candidates = [
		"/Applications/Android Studio.app/Contents/jbr/Contents/Home",
		"/Applications/Android Studio Preview.app/Contents/jbr/Contents/Home",
		join(homedir(), "Applications/Android Studio.app/Contents/jbr/Contents/Home"),
	];
	return candidates.find((c) => existsSync(join(c, "bin", "java"))) ?? null;
}

const java21 = resolveJava21();
if (!java21) {
	console.error(
		"[run-android] No JDK 21 found. Install one (Android Studio bundles it) or set JAVA_HOME to a JDK 21.\n" +
			"  Expected at: /Applications/Android Studio.app/Contents/jbr/Contents/Home",
	);
	process.exit(1);
}

const child = spawn("cap", process.argv.slice(2), {
	stdio: "inherit",
	env: { ...process.env, JAVA_HOME: java21 },
});
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
	console.error("[run-android] failed to launch cap:", err.message);
	process.exit(1);
});
