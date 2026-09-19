// Commit and tag through GitHub's API rather than `git push`, for release jobs on a runner.
//
// Two reasons, both about a runner having no key of its own. A commit made with
// `createCommitOnBranch` is signed by GitHub and shows as verified, where a runner's `git commit`
// would be unsigned; and it lands only if the branch still points where the build started
// (`expectedHeadOid`), so a release can never be committed on top of something it did not build.
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
	// stdin, not -f: the file contents would otherwise land in argv, and a changelog directory
	// can outgrow the argument limit long before it outgrows anything else.
	const out = execFileSync("gh", ["api", "graphql", "--input", "-"], {
		input: body,
		encoding: "utf8",
	});
	const oid = JSON.parse(out)?.data?.createCommitOnBranch?.commit?.oid;
	if (!oid) throw new Error(`createCommitOnBranch returned no commit: ${out.slice(0, 300)}`);
	return oid;
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
