// Follows a desktop release AND the sign-windows.yml run it starts, a line per change, and, when
// SignPath is the signer, says when to go and approve there. `gh run watch` sees only the first
// run, so it would sit silent through the one step that waits on you outside GitHub. Azure needs
// no approval and its job never matches SIGN_JOB. See docs/release-signing.md.

export interface Job {
	name: string;
	status: string;
	conclusion: string | null;
	databaseId: number;
}

const SIGN_WORKFLOW = "sign-windows.yml";
/** The SignPath job in sign-windows.yml, which submits and waits. Must match the workflow. */
export const SIGN_JOB = "Sign with SignPath";

function describe(job: Job): string {
	if (job.status === "completed") return job.conclusion ?? "completed";
	// A job held at an environment's required reviewers.
	if (job.status === "waiting") return "waiting for your approval";
	return job.status.replace("_", " ");
}

/** One line per job whose state moved since `seen`, which is updated to match. */
export function jobChanges(jobs: Job[], seen: Map<string, string>, prefix = ""): string[] {
	const lines: string[] = [];
	for (const job of jobs) {
		const now = describe(job);
		if (seen.get(job.name) === now) continue;
		seen.set(job.name, now);
		lines.push(`  ${prefix}${job.name}: ${now}`);
	}
	return lines;
}

/**
 * The prompt to go and approve, once the signing job has started.
 *
 * Read from the job's status, the one thing GitHub reports live: the run's notices and summaries
 * appear only when the job ends, which during an approval wait is after you have approved.
 */
export function approvalPrompt(jobs: Job[], requests?: string): string | null {
	const signing = jobs.some((j) => j.name === SIGN_JOB && j.status === "in_progress");
	if (!signing) return null;
	return requests
		? `\n  windows: approve the newest signing request in SignPath now:\n    ${requests}\n`
		: "\n  windows: approve the newest signing request in SignPath now (SignPath emails you the link).\n";
}

/** `gh` with these arguments, returning stdout; throws when it fails. */
export type Gh = (args: string[]) => string;

export interface WatchOptions {
	repo: string;
	runId: string;
	/** When the release was dispatched: tells its signing run apart from older ones. */
	since: string;
	/** Whether this release builds Windows at all. */
	windows: boolean;
	/** SignPath's signing-requests page for this organization, when it is known. */
	signpathRequests?: string;
	pollMs?: number;
}

export interface WatchDeps {
	gh: Gh;
	sleep(ms: number): void;
	log(line: string): void;
}

/** Follow the release until it finishes, and return its conclusion. */
export function watchDesktopRelease(o: WatchOptions, deps: WatchDeps): string {
	const pollMs = o.pollMs ?? 30_000;
	const json = <T>(args: string[]): T => JSON.parse(deps.gh(args)) as T;
	const seen = new Map<string, string>();
	const seenWindows = new Map<string, string>();
	let signRun: string | null = null;
	let signDone = false;
	let prompted = false;
	let failures = 0;

	for (;;) {
		let release: { status: string; conclusion: string | null; jobs: Job[] } | null = null;
		try {
			release = json([
				"run",
				"view",
				o.runId,
				"--repo",
				o.repo,
				"--json",
				"status,conclusion,jobs",
			]);
			failures = 0;
		} catch (e) {
			// A dropped connection is ordinary over hours; only a run of them gives up.
			if (++failures >= 10) throw e;
		}
		if (release) for (const line of jobChanges(release.jobs, seen)) deps.log(line);

		if (o.windows && !signDone) {
			try {
				if (!signRun) {
					const runs = json<{ databaseId: number; createdAt: string }[]>([
						"run",
						"list",
						"--repo",
						o.repo,
						"--workflow",
						SIGN_WORKFLOW,
						"--event",
						"workflow_dispatch",
						"--limit",
						"5",
						"--json",
						"databaseId,createdAt",
					]);
					const mine = runs
						.filter((r) => r.createdAt >= o.since)
						.sort((a, b) => b.databaseId - a.databaseId)[0];
					if (mine) {
						signRun = String(mine.databaseId);
						deps.log(`  windows: building in https://github.com/${o.repo}/actions/runs/${signRun}`);
					}
				}
				if (signRun) {
					const sign = json<{ status: string; jobs: Job[] }>([
						"run",
						"view",
						signRun,
						"--repo",
						o.repo,
						"--json",
						"status,jobs",
					]);
					for (const line of jobChanges(sign.jobs, seenWindows, "windows: ")) deps.log(line);
					const prompt = prompted ? null : approvalPrompt(sign.jobs, o.signpathRequests);
					if (prompt) {
						deps.log(prompt);
						prompted = true;
					}
					if (sign.status === "completed") signDone = true;
				}
			} catch {
				// A courtesy: the release run decides the outcome, and it waits on this one anyway.
			}
		}

		if (release?.status === "completed") return release.conclusion ?? "unknown";
		deps.sleep(pollMs);
	}
}
