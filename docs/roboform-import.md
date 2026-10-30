# RoboForm import: the CSV format

What `import/roboform.ts` has to cope with, and the evidence for each rule.

Fixture: `clients/extension/src/fixtures/imports/roboform.csv`.

## What the export holds

RoboForm's CSV export (extension or web: Settings → Account & Data → Export; Windows desktop:
Options → Account & Data → Export) carries **Logins, Bookmarks and Safenotes only**. Identities,
which is where RoboForm keeps credit cards, never reach the CSV. The only way to get them out is
Print List, which produces an HTML page that we don't read. The provider card says so instead of
leaving the user to wonder where their cards went.

## Header

```
Name,Url,MatchUrl,Login,Pwd,Note,Folder,RfFieldsV2   # extension and web
Name,URL,MatchUrl,Login,Password,Note,Folder,RfFieldsV2   # Windows desktop app
```

Read by header name (lower-cased), with `pwd` and `password` both accepted. The file starts with a
UTF-8 BOM and uses LF line endings; `parseCsvRows` handles both. `ROBOFORM_CSV` in `csv-format.ts`
leaves the password column out of its signature so both variants match, and no other CSV format we
read has a `login` or `folder` column, so the signatures stay exclusive.

## Row kinds

Nothing marks a row's kind; it is inferred from which columns are filled.

| Filled | Kind | Becomes |
| --- | --- | --- |
| `MatchUrl`, `Login`, `Pwd` or any field | Login | login |
| `Url` only | Bookmark | note with a `URL` field, so an empty login never offers itself for autofill |
| `Name` / `Note` only | Safenote | note |
| nothing | | skipped, counted |

A login keeps both `Url` (where RoboForm navigates) and `MatchUrl` (what it matches on) when they
differ. A safenote row stops after `Folder`: it has fewer cells than the header.

## The fields column spills over

`RfFieldsV2` is not one cell. Every cell from it to the end of the row is one field, each
`<name>,<?>,<?>,<txt|pwd>,<value>`:

```
...,"User ID$,,,txt,jane@example.com","Password$,,,pwd,123456","TOTP KEY$,,,txt,JBSWY3DPEHPK3PXP"
```

- `User ID$` and `Password$` repeat `Login` and `Pwd`. Dropped when equal, kept as `Username` /
  `Password` fields when not.
- `TOTP KEY$` is a bare base32 secret and becomes the login's TOTP.
- `pwd`-typed fields are masked. `-no-name-` and blank names become `Field`.
- The value runs to the end of the cell, so a value holding commas stays whole. (Bitwarden splits
  on every comma and truncates it.)
- A cell that doesn't fit the pattern, including the older `Rf_fields` format, is kept verbatim as
  a `Field`.

## Escaped leading quote

RoboForm escapes a value a spreadsheet would read as a formula by prepending `'`, in both the
`Login`/`Pwd` columns and the field values. A value that really starts with `'` gets one too, so
the escape is reversible. Exactly one leading `'` is dropped, and only before `=`, `+`, `-`, `@` or
`'`: `'=x` → `=x`, `''x` → `'x`, `'x` stays `'x`.

A real export confirms `=` (2026-10-30); Proton's fixture shows `@` and `'`. `+` and `-` are the
rest of the standard formula-escape set and are assumed. Stripping before them is safe either way:
since a real leading `'` is always doubled, a single `'` before them can only be RoboForm's.

## Folders

`Folder` is a `/`-separated path with a leading slash (`/Work/Clients`). One tag per level, as for
LastPass and AliasVault, and the import warns once with the count.

## Provenance

The fixture is written from scratch with invented data, in the shape of a real export from the
RoboForm extension (2026-10-30): BOM, LF, the spilled fields column, a custom field, a TOTP key,
a short safenote row and a nested folder. The rules were also checked against:

- `ProtonMail/WebClients` `packages/pass/lib/import/providers/roboform/` (the quote escaping,
  bookmarks, nested folders)
- `bitwarden/clients` `libs/importer/src/importers/roboform-csv-importer.ts`, and its PR #18403
  for the Windows desktop header
- RoboForm's help article "How to export your RoboForm logins into a CSV file" for the three data
  types the CSV holds
