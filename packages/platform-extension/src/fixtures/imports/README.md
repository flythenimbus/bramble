# Import fixtures

Sample export files, one per format we import, used by the unit tests in
`packages/core/src/import/` and the end-to-end specs in `e2e/extension/`.

Everything here is fake data except where noted below. Passwords are `123456` unless a spec
says otherwise.

## Credentials in this directory are deliberate, disposable, and worth understanding

Three files contain real private keys. That is the point of them: a passkey importer cannot be
tested against a key that is not a key, and a fabricated one would not prove we read what the
source application actually writes.

| File | Key | Why it is safe to commit |
|---|---|---|
| `bitwarden-passkeys.json` | P-256 | Generated for the tests, never registered anywhere |
| `keepass-passkeys.xml` / `.kdbx` | Ed25519 | Generated for the tests, never registered anywhere |
| `passkey_db.kdbx` | Ed25519 | **Registered, but only to webauthn.io**, a public demo site, under a throwaway account |

**`passkey_db.kdbx` is the one to read twice before touching.** It is a genuine KeePassXC 2.7.12
database, password `qwerty`, holding a passkey that really does authenticate to webauthn.io as
`testy`. It is committed on purpose:

- It is the only fixture KeePassXC itself wrote. `keepass-passkeys.kdbx` came from Bramble's own
  KDBX exporter, so on its own it cannot show that we read a real KeePassXC file rather than one
  shaped the way we happen to write them.
- Its KDF settings are a stock KeePassXC benchmark result (Argon2d, 64 MiB, 106 rounds), which is
  what issue #78 was actually about: the old per-axis ceiling of 64 rounds rejected it.
- The credential it protects is worth nothing. webauthn.io is a public demonstration site with no
  data behind it and an account anyone can create.

So: do not add a fixture with a key that guards anything real, do not reuse this database outside
these tests, and if you need a similar one, make a fresh throwaway rather than borrowing a key
from somewhere that matters.

## Provenance notes

`keepass-passkeys.kdbx` was written by Bramble's own KDBX exporter, not by `keepassxc-cli`. The
CLI's `import` subcommand produces an AES-KDF database, which our reader refuses by design, and it
exposes no way to choose Argon2. KeePassXC opens the result, which is the cross-check that it is a
real KDBX4 file and not merely one we can read.

`keepass.xml` carries all five predefined XML entities plus a numeric character reference in one
password, covering issue #79.
