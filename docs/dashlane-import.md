# Dashlane import: the CSV export

What `import/dashlane.ts` has to cope with, and the evidence for each rule.

Fixture: `clients/extension/src/fixtures/imports/dashlane.zip`.

## The export is a zip of CSVs

Dashlane's unencrypted export (`dashlane-credential-export.zip`) holds up to five CSVs, with CRLF
line endings and no BOM. The encrypted `.dash` archive is not read.

| File | Header | Becomes |
| --- | --- | --- |
| `credentials.csv` | `username,username2,username3,title,password,note,url,category,otpUrl` | logins |
| `securenotes.csv` | `title,note,category` (older: `title,note`) | notes |
| `payments.csv` | `type,account_name,account_holder,cc_number,code,expiration_month,expiration_year,routing_number,account_number,country,issuing_bank,note,name` | cards; bank accounts as notes |
| `ids.csv` | `type,number,name,issue_date,expiration_date,place_of_issue,state` | notes |
| `personalInfo.csv` | `type,title,first_name,middle_name,last_name,login,date_of_birth,place_of_birth,email,email_type,item_name,phone_number,address,country,state,city,zip,address_recipient,address_building,address_apartment,address_floor,address_door_code,job_title,url` | notes |

Each file is recognised by its **header**, not its name, so a renamed file or one in a subfolder
still imports. Credentials are tried before secure notes, because a credentials header holds
`title` and `note` too. A file that matches no header is named in a warning rather than dropped in
silence. Entries are imported logins first, then notes, cards, IDs and personal info.

### A lone CSV

Safari unzips downloads by default, so a Mac user may only have the loose files. The card accepts
any one of them and warns that the rest of the export is in the other files. A lone CSV that isn't
one of Dashlane's is checked against the other CSV formats (`assertFormat`), so a mis-picked
LastPass file is named.

## Columns that changed

- **TOTP.** `otpUrl` (a full `otpauth://` URI) replaced `otpSecret` (a bare secret); an October
  2024 export already has it. Either is read; `parseTotp` accepts both.
- **Cards.** Older exports call a card `credit_card` and have no `note` or `name` column. Current
  ones say `payment_card` and add both. A card is named by `name`, falling back to `account_name`
  (the holder), which is also the cardholder.

## Mapping

The vault has no identity or bank type, so IDs, personal info and bank accounts become notes, with
every non-empty column kept as a field under a readable label. A column not listed in `LABELS` keeps
the name Dashlane gave it, so a column added later is not lost.

- **`username2`, `username3`** become `Username 2` / `Username 3` fields.
- **`category`** lists the item's collections, comma-separated (`Personal, Shopping` for an item in
  two). Each becomes a tag, and the import warns once with the count.
- **IDs** are named `<kind> (<holder>)`, e.g. `Passport (Jane Sample)`. Dashlane drops the
  leading zero from months and days (`2022-1-30`), so dates are padded to `2022-01-30`.
- **Personal info** has one row per detail (a name, an email, a phone number, an address). Each row
  is its own note: a `name` row is named after the person, any other row by its `item_name`, or by
  its kind (`Email`, `Phone`, `Address`) when that is empty, as it is on a real email row.

## Provenance

The fixture is written from scratch with invented data, in the layout of a real export made
2026-10-30 (CRLF, `category` on secure notes, an item in two collections, an email row with no
`item_name`). The rules were also checked against:

- `ProtonMail/WebClients` `packages/pass/lib/import/providers/dashlane/` (a real export zip from
  October 2024, the `otpUrl` change, `payment_card` with `note` and `name`)
- `bitwarden/clients` `libs/importer/src/importers/dashlane/` and its spec data (the older
  `otpSecret` and `credit_card`, bank accounts, IDs, unpadded dates, every personal-info type)
