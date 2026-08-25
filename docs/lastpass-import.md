# LastPass import: the CSV format

What `import/lastpass.ts` has to cope with, and the evidence for each rule. Every claim below is
confirmed against at least two real exports (see [Provenance](#provenance)).

Fixtures: `packages/platform-extension/src/fixtures/imports/lastpass.csv` (current header) and
`lastpass-legacy.csv` (pre-TOTP header).

## Two header variants

```
url,username,password,totp,extra,name,grouping,fav   # current
url,username,password,extra,name,grouping,fav        # pre-2022, still in the wild
```

`totp` was inserted in the middle, so column order cannot be assumed. Read the header row.
Both variants are ordinary RFC 4180: quoted only where needed, `""` for a literal quote,
raw newlines inside quoted fields. `parseCsvRows` in `import/shared.ts` already handles all of it,
including the BOM.

## Columns

| Column | Notes |
| --- | --- |
| `url` | `http://sn` marks a secure note. A bare `http://` is LastPass's placeholder for "no URL". Empty is also possible. Garbage passes through unvalidated (`htts:/broken.url`). |
| `totp` | Either a bare base32 secret or a full `otpauth://` URI. `parseTotp` accepts both, so pass it through verbatim like the Bitwarden importer does. |
| `extra` | Note body for a secure note, free-text note for a login. May be multi-line. |
| `grouping` | Folder path, `\`-separated for nesting (`Dev\Hosting`). Shared folders arrive prefixed `Shared-<name>`. |
| `fav` | `0` or `1`. |

The vault has no folder or favourite concept. `grouping` is a readable path the user chose, so it
is kept as a `Folder` custom field and the import warns once that it did; `fav` means nothing
outside LastPass and is dropped.

## Typed secure notes

When `url` is `http://sn`, `extra` may start with `NoteType:`, and the body is then a
`Key:Value` block:

```
NoteType:Credit Card
Language:en-US
Name on Card:Alice Example
Type:Visa
Number:4111111111111111
Security Code:123
Start Date:January,2022
Expiration Date:November,2030
Notes:Primary card
```

Four traps, each of which breaks a naive `split(":")` / `split("\n")` parse:

1. **Values contain commas.** `Expiration Date:January,2025`, `Birthday:August,23,1990`,
   `Start Date:,` when unset. The field is CSV-quoted, so this is only a hazard if you
   re-split the value.
2. **Values contain colons.** `Timezone:+01:00,1`, and phone fields are JSON blobs
   (`Phone:{"num":"48404505606","ext":"11","cc3l":"POL"}`). Split on the **first** colon only.
3. **Values contain newlines.** `SSH Key` / `Private Key` holds a real PEM block spanning
   several lines. A line-by-line scan reads `-----END OPENSSH PRIVATE KEY-----` as a new key.
   The templates below give the field order, so consume until the next expected key.
4. **`Notes:` runs to the end.** It is always last and may be multi-line, so everything after
   it belongs to the note body, not to a new key.

`Language:` is emitted for every typed note and carries no user data. It is sometimes **empty**
(`Language:` with nothing after it), so its presence cannot be used to detect a typed note.

### Dates

Date-bearing fields are `<Month>,<Year>` or `<Month>,<Day>,<Year>`, and the month is always the
**English** name. A genuine `pl-PL` export still writes `November`, `April`, `June`, so one
English month table is enough and the `Language:` value can be ignored.

Nothing else about them is reliable:

- The year may be four digits (`November,2030`) or two (`April,29`).
- The whole value may be empty (`Start Date:,`).
- It may be junk the user typed (`Purchase Date:April,123,123123`).

For a credit card this is not a problem. `CardExpYearSchema` in `util/card.ts` already accepts
`YY` or a full `20xx`, and the edit form's field is labelled `Year (YY)`, so `April,29` maps
straight to `expYear: "29"` with no normalization. The month **does** need converting, because
`CardExpMonthSchema` demands digits: store `expMonth: "4"`, not `"April"`.

Anywhere else, keep the value verbatim in a custom field. It is free text.

### Templates

Field order per type, from `lastpass-cli`'s `notes.c` (mirrored in `jeduardo/lastpass-rs`):

| Type | Fields |
| --- | --- |
| Bank Account | Bank Name, Account Type, Routing Number, Account Number, SWIFT Code, IBAN Number, Pin, Branch Address, Branch Phone |
| Credit Card | Name on Card, Type, Number, Security Code, Start Date, Expiration Date |
| Database | Type, Hostname, Port, Database, Username, Password, SID, Alias |
| Driver's License | Number, Expiration Date, License Class, Name, Address, City / Town, State, ZIP / Postal Code, Country, Date of Birth, Sex, Height |
| Email Account | Username, Password, Server, Port, Type, SMTP Server, SMTP Port |
| Health Insurance | Company, Company Phone, Policy Type, Policy Number, Group ID, Member Name, Member ID, Physician Name, Physician Phone, Physician Address, Co-pay |
| Instant Messenger | Type, Username, Password, Server, Port |
| Insurance | Company, Policy Type, Policy Number, Expiration, Agent Name, Agent Phone, URL |
| Membership | Organization, Membership Number, Member Name, Start Date, Expiration Date, Website, Telephone, Password |
| Passport | Type, Name, Country, Number, Sex, Nationality, Date of Birth, Issued Date, Expiration Date |
| Server | Hostname, Username, Password |
| Social Security | Name, Number |
| Software License | License Key, Licensee, Version, Publisher, Support Email, Website, Price, Purchase Date, Order Number, Number of Licenses, Order Total |
| SSH Key | Bit Strength, Format, Passphrase, Private Key, Public Key, Hostname, Date |
| Wi-Fi Password | SSID, Password, Connection Type, Connection Mode, Authentication, Encryption, Use 802.1X, FIPS Mode, Key Type, Protected, Key Index |

Two gaps in that list, both real:

- **`Address`** is absent from `notes.c` but is emitted by the browser extension. Field order,
  taken from real exports: Title, First Name, Middle Name, Last Name, Username, Gender, Birthday,
  Company, Address 1, Address 2, Address 3, City / Town, County, State, Zip / Postal Code,
  Country, Timezone, Email Address, Phone, Evening Phone, Mobile Phone, Fax.
- **`Custom_<digits>`** is a user-defined template. Field names are arbitrary and unknowable
  ahead of time, so it has to fall back to "every line is a `Key:Value` until `Notes:`".

`notes.c` also lists `American Express`, `Mastercard` and `VISA` as note types with **no** fields.
No real export in hand contains one, so their shape is unconfirmed and the fixture omits them.

## Nothing else is trustworthy either

A card's `Type` is free text and not a brand: a real export carries `Type:CC`. Its `Number` need
not be a real card number and may fail both Luhn and every brand prefix, so `cardBrand()` returns
nothing. Neither is a reason to reject the entry. `entryDataSchema` types these as plain strings
and only the **edit form** applies `CardNumberSchema`, so an implausible card imports fine and is
flagged if the user opens it.

`name` can carry a trailing space (`TablePlus License `), because `parseCsvRows` never trims, by
design. Trim it for display.

## Mapping to vault types

The vault has `login`, `card`, `note`, `ssh-key`:

- `Credit Card` becomes a `card`, with `Expiration Date` split per [Dates](#dates). The brand comes
  from the number via `cardBrand()`, falling back to `Type` only when that names a real brand. A
  `Type` that did not supply the brand is kept as a field rather than dropped.
- `SSH Key` becomes an `ssh-key` when a key actually came across, and a `note` when it did not.
- Everything else becomes a `note` carrying the `Key:Value` pairs as custom fields, which is what
  the Bitwarden importer already does for identities. `Password`, `Pin` and `Passphrase` fields
  arrive masked.

Empty template fields and dates written as bare commas are dropped rather than kept as blanks.

## The Google signature collision

`csv.ts` accepted a file as a Google Password Manager export when the header contained
`name`, `url`, `username`, `password`. A LastPass header contains all four, so a LastPass file
handed to the Google card imported silently and wrongly: secure notes became junk logins, and
`totp`, `extra` and `grouping` were dropped without a warning.

Header detection now lives in `csv-format.ts`, where `GOOGLE_CSV` carries a `reject` list
(`extra`, `grouping`) that no Google export has and every LastPass one does. That makes the three
signatures mutually exclusive, so a mis-picked file is named in either direction rather than
half-imported.

## Provenance

The fixtures are written from scratch with invented data. The *format* was confirmed against
eight real-world exports, chiefly:

- `ProtonMail/WebClients` `packages/pass/lib/import/providers/lastpass/mocks/lastpass.csv`
- `twofas/2fas-pass-ios` `2PASS/DataTests/Resources/Lastpass.csv` (a genuine `pl-PL` export)
- `roddhjav/pass-import` `tests/assets/db/lastpass.csv` (legacy header)
- `aliasvault/aliasvault`, `buttercup/buttercup-importer`

A user's own export supplied the blank `Language:`, the two-digit years, the junk date, the
non-brand card `Type`, and the trailing space in `name`.

Templates from `jeduardo/lastpass-rs` `src/notes.rs`, itself a port of `lastpass-cli`'s `notes.c`.
