// Commit and tag through GitHub's API rather than `git push`, for release jobs on a runner.
//
// Two reasons, both about a runner having no key of its own. A commit made with
// `createCommitOnBranch` is signed by GitHub and shows as verified, where a runner's `git commit`
// would be unsigned; and it lands only if the branch still points where it was told to
// (`expectedHeadOid`), so a release can never be committed on top of something it did not build.
// The one exception is other releases' version bumps, which touch nothing it built: see
// commitOverReleases.
//
// Needs GH_TOKEN with contents: write. See docs/ci-releases.md.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MUTATION = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid } }
}`;

/** Commit `files` (repo-relative paths, read from the working tree) onto `branch`. Returns the oid. */
export function commitFiles(opts: {
	repo: string;
	branch: string;
	expectedHeadOid: string;
	headline: string;
	files: string[];
}): string {
	const body = JSON.stringify({
		query: MUTATION,
		variables: {
			input: {
				branch: { repositoryNameWithOwner: opts.repo, branchName: opts.branch },
				message: { headline: opts.headline },
				expectedHeadOid: opts.expectedHeadOid,
				fileChanges: {
					additions: opts.files.map((path) => ({
						path,
						contents: readFileSync(path).toString("base64"),
					})),
				},
			},
		},
	});
	// A token that may write to a protected branch, falling back to the ambient one.
	//
	// GITHUB_TOKEN cannot: a ruleset evaluates it as the GitHub Actions app, and exempting that
	// app would exempt every workflow. Adding github-actions[bot] as a user was measured and does
	// nothing. So release workflows mint a token from an app of our own that the ruleset does allow
	// through, holding contents:write and nothing else. See docs/ci-releases.md.
	const out = gh(["api", "graphql", "--input", "-"], body);
	const oid = JSON.parse(out)?.data?.createCommitOnBranch?.commit?.oid;
	if (!oid) throw new Error(`createCommitOnBranch returned no commit: ${out.slice(0, 300)}`);
	return oid;
}

/**
 * Why a release cannot be committed over what landed on the branch since its build, or null when
 * it can.
 *
 * Releases are dispatched together and approved whenever someone gets to them, so another target's
 * version bump landing mid-build is the normal case, and refusing it made the order of approvals
 * matter. It can be committed over only when it is provably inert for this release: every commit
 * is a release commit, every file it touched is release metadata (each target's version, the
 * desktop update manifest), and none is a file this release writes, which it would otherwise
 * overwrite from a stale copy. The tree tagged is then what was built plus other targets' version
 * numbers. Anything else, a code change above all, still refuses.
 */
export function overReleasesRefusal(opts: {
	commits: { sha: string; headline: string }[];
	changed: string[];
	own: string[];
	isReleaseFile: (path: string) => boolean;
}): string | null {
	for (const c of opts.commits) {
		if (!c.headline.startsWith("chore(release): "))
			return `${c.sha.slice(0, 9)} "${c.headline}" is not a release commit`;
	}
	for (const path of opts.changed) {
		if (!opts.isReleaseFile(path)) return `${path} changed, and it is not release metadata`;
		if (opts.own.includes(path)) return `${path} changed, and this release writes it too`;
	}
	return null;
}

/**
 * Commit onto `branch` from `base`, over any release bumps that landed since. Returns the oid.
 *
 * Re-reads the branch and retries when another commit lands between the check and the write, the
 * case two approvals a few seconds apart produce.
 */
export function commitOverReleases(opts: {
	repo: string;
	branch: string;
	base: string;
	headline: string;
	files: string[];
	isReleaseFile: (path: string) => boolean;
}): string {
	for (let attempt = 1; ; attempt++) {
		const head = gh([
			"api",
			`repos/${opts.repo}/git/ref/heads/${opts.branch}`,
			"--jq",
			".object.sha",
		]).trim();
		if (head !== opts.base) {
			const cmp = JSON.parse(gh(["api", `repos/${opts.repo}/compare/${opts.base}...${head}`])) as {
				status: string;
				total_commits: number;
				commits: { sha: string; commit: { message: string } }[];
				files?: { filename: string; previous_filename?: string }[];
			};
			// Behind or diverged: the base is not on the branch any more, so nothing can be vouched for.
			if (cmp.status !== "ahead")
				throw new Error(`${opts.branch} is ${cmp.status} of ${opts.base.slice(0, 9)}`);
			// The compare API lists at most 250 commits and 300 files; past either, the check below
			// would be blind to the rest.
			const files = cmp.files ?? [];
			if (cmp.commits.length < cmp.total_commits || files.length >= 300)
				throw new Error(
					`too much landed on ${opts.branch} since ${opts.base.slice(0, 9)} to check`,
				);
			const why = overReleasesRefusal({
				commits: cmp.commits.map((c) => ({
					sha: c.sha,
					headline: c.commit.message.split("\n")[0] ?? "",
				})),
				changed: files.flatMap((f) =>
					f.previous_filename ? [f.filename, f.previous_filename] : [f.filename],
				),
				own: opts.files,
				isReleaseFile: opts.isReleaseFile,
			});
			if (why)
				throw new Error(
					`${opts.branch} moved from ${opts.base.slice(0, 9)} to ${head.slice(0, 9)} and cannot be committed over: ${why}`,
				);
			console.log(
				`${opts.branch} moved to ${head.slice(0, 9)} with release bumps only; committing over them`,
			);
		}
		try {
			return commitFiles({
				repo: opts.repo,
				branch: opts.branch,
				expectedHeadOid: head,
				headline: opts.headline,
				files: opts.files,
			});
		} catch (e) {
			const err = e as { stdout?: unknown; message?: string };
			const stale = /STALE_DATA|Expected branch to point to/.test(
				`${err.stdout ?? ""} ${err.message ?? ""}`,
			);
			if (!stale || attempt >= 5) throw e;
		}
	}
}

/**
 * gh, as the release app when there is one. Reads go through it too, so a check and the write it
 * guards see the same repository.
 */
function gh(args: string[], input?: string): string {
	const token = process.env.BRAMBLE_COMMIT_TOKEN;
	return execFileSync("gh", args, {
		encoding: "utf8",
		...(input === undefined ? {} : { input }),
		...(token ? { env: { ...process.env, GH_TOKEN: token } } : {}),
	});
}

/** A lightweight tag, as `git tag <name>` makes locally. */
export function createTag(repo: string, tag: string, sha: string): void {
	execFileSync(
		"gh",
		[
			"api",
			"-X",
			"POST",
			`repos/${repo}/git/refs`,
			"-f",
			`ref=refs/tags/${tag}`,
			"-f",
			`sha=${sha}`,
		],
		{ stdio: ["ignore", "ignore", "inherit"] },
	);
}
