# Mailbox server

Store-and-forward sync for devices that are never online at the same time: it holds sealed
changes and files only until every device in the group has them, then deletes them. Not built
yet; the design is [../../docs/mailbox-service.md](../../docs/mailbox-service.md).

Licensed AGPL-3.0-only (see [LICENSE](LICENSE)), unlike the rest of the repository
(GPL-3.0-only): anyone who runs a modified mailbox for others must offer them its source.
