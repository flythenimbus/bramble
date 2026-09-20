# Release notes written by hand

One optional file per release, named after its tag: `0.9.0-desktop.md`, `1.30.0-chromium.md`.

A release page is generated from the commit range, which answers *what changed*. This is where
*why you would want it* goes, and it is the only part a person writes. `scripts/release.ts` puts it
above the generated changelog, so nothing is lost by adding one.

**The first line has a second job.** For a desktop release it becomes the text in the in-app update
prompt (`notes` in `latest.json`), which is a modal, not a changelog: one sentence, no heading
syntax, no markdown links. Everything after it is release-page only.

```markdown
Fixes the white screen on Arch and other current-Mesa systems.

arm64 Linux can install from the apt repository at last: the snippet claimed amd64 only, so apt
skipped the repository without saying so.
```

Write it before running the release and commit it: the release builds on a runner, which has no
terminal to open an editor in and no model to draft with, so a file committed beforehand is the
only way a human sentence reaches the page. Without one, the release still goes out with the
generated changelog, and `gh release edit <tag> --notes-file <file>` can still fix it afterwards.

A local release (`--local`) additionally drafts a summary with the model in `scripts/i18n/ollama.mjs`
and opens it in `$EDITOR`; this file is used there too, as the preamble.
