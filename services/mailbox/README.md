# Mailbox server

Store-and-forward sync for devices that are never online at the same time: it holds sealed
changes and files only until every device in the group has them, then deletes them. The design
is [../../docs/mailbox-service.md](../../docs/mailbox-service.md); the server reads nothing it
stores, and every request is signed by a device in the group.

Licensed AGPL-3.0-only (see [LICENSE](LICENSE)), unlike the rest of the repository
(GPL-3.0-only): anyone who runs a modified mailbox for others must offer them its source.

## Run it

Node 24 runs the TypeScript directly; there is no build step.

```sh
pnpm install
pnpm --filter bramble-mailbox-server start     # http://localhost:7401
```

`GET /health` answers `ok`. Everything else is under `/v1` and needs a signed request from the
app.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `7401` | Port to listen on (the signalling relay uses 7400). |
| `DATA_DIR` | `./data` | Where `mailbox.db` and the `bodies/` directory live. Back it up or not: everything in it is in transit, and the apps hold the real copies. |
| `MAILBOX_TOKEN` | unset | When set (at least 16 of `A-Z a-z 0-9 _ -`), every `/v1` request must carry it, which makes the mailbox private to whoever has the token. `/health` stays open. |
| `RETENTION_MAX_DAYS` | `365` | The longest anything is held for a device that never collects it. Clients can ask for less, never more. |
| `QUOTA_BYTES` | unset | The most one mailbox may hold at once. Unset means no limit. |

An invalid value stops the server before it listens, naming the variable (never its value).
The server logs its listening line and errors only: no requests, no addresses.

For devices off your network, put it behind a TLS reverse proxy and give the app
`https://<host>`. The token goes in the app's mailbox settings, never in the URL, so it cannot end
up in a proxy's access log.
