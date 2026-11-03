# Proton Pass import: the zip export

What `import/protonpass.ts` has to cope with, and the evidence for each rule. Passkeys have their
own section in [passkey-import.md](passkey-import.md#proton-pass).

Fixtures: `clients/extension/src/fixtures/imports/protonpass-passkeys.zip` (a passkey) and
`protonpass-files.zip` (attachments and website rules), both cut down from real Proton Pass 1.43.0
exports.

## The export is a zip

`Proton Pass/data.json` holds a `vaults` map, each vault with its `items`. Trashed items (`state`
2) are skipped. A passphrase-protected export holds `data.pgp` instead and is refused as not a
Proton export. Proton's CSV export is not read.

## Websites carry a rule each

A login's websites are in `content.autofillUrls`, each with a `mode`. The older `content.urls`
repeats only the Default ones, for importers that predate the rules (Proton's
`store/selectors/export.ts` says so), so reading only `urls` loses every website whose rule was
changed.

| `mode` | Proton calls it | Becomes |
| --- | --- | --- |
| 0 | Default | a website |
| 1, 3, 4, 5, 6 | Exact, Starts with, Pattern, Regular expression, Exact path | a website, and the login matches exact sites only |
| 2 | Never | a `Never autofill on` field, not a website |

Bramble has one match setting per login, not per website, so a narrowed website tightens the
whole login; the Bitwarden import does the same. A Pattern or Regular expression value is kept as
written even though it will not match as a URL. A Never website stays out of the website list,
because there it would be offered and filled on exactly the site the user ruled out. Each kind is
counted in one warning. A website only `urls` lists is kept too, so an older export loses nothing.

## Files sit beside data.json

Proton writes files only when the export's file attachments option is on, and not in a CSV. Each
item lists its files in `files`, and each is stored at `Proton Pass/files/<that name>`, with `/`
and `\` turned into `_` (Proton's `sanitizeFileName`).

The listed name is `<base>.<hash of the share id><hash of the file id><ext>`, where `ext` is the
last `.xxx` and each hash is `Math.abs(getHashCode(id)).toString(16)`, the Java string hash as a
32-bit int (`lib/file-attachments/helpers.ts`). The share id is on the item, so its half can be
recomputed exactly and the original name recovered; a name that doesn't fit is kept as exported.
A listed file the zip doesn't hold is counted in a warning.

**Status:** checked against a real export with three files, including one with no extension.
