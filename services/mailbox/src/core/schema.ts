// The mailbox's metadata. Bodies (messages and blobs) live in a BodyStore, never in a row. Times are
// epoch milliseconds; `lastCheckedDay` is whole days since the epoch, coarse on purpose.
// Cascades keep cleanup to one statement: deleting a member, message, blob or mailbox takes its
// deliveries, wants and markers with it.

import { foreignKey, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const mailboxes = sqliteTable("mailboxes", {
	id: text("id").primaryKey(),
	retentionDays: integer("retention_days").notNull(),
	createdAt: integer("created_at").notNull(),
});

export const members = sqliteTable(
	"members",
	{
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailboxes.id, { onDelete: "cascade" }),
		sigKey: text("sig_key").notNull(),
		status: text("status", { enum: ["eligible", "active"] }).notNull(),
		addedAt: integer("added_at").notNull(),
		lastCheckedDay: integer("last_checked_day"),
	},
	(t) => [primaryKey({ columns: [t.mailboxId, t.sigKey] })],
);

export const messages = sqliteTable(
	"messages",
	{
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailboxes.id, { onDelete: "cascade" }),
		id: text("id").notNull(),
		sender: text("sender").notNull(),
		size: integer("size").notNull(),
		createdAt: integer("created_at").notNull(),
		expiresAt: integer("expires_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.mailboxId, t.id] }),
		index("messages_expires_at").on(t.expiresAt),
	],
);

export const deliveries = sqliteTable(
	"deliveries",
	{
		mailboxId: text("mailbox_id").notNull(),
		messageId: text("message_id").notNull(),
		member: text("member").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.mailboxId, t.messageId, t.member] }),
		index("deliveries_member").on(t.mailboxId, t.member),
		foreignKey({
			columns: [t.mailboxId, t.messageId],
			foreignColumns: [messages.mailboxId, messages.id],
		}).onDelete("cascade"),
		foreignKey({
			columns: [t.mailboxId, t.member],
			foreignColumns: [members.mailboxId, members.sigKey],
		}).onDelete("cascade"),
	],
);

export const blobs = sqliteTable(
	"blobs",
	{
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailboxes.id, { onDelete: "cascade" }),
		hash: text("hash").notNull(),
		size: integer("size").notNull(),
		uploader: text("uploader").notNull(),
		createdAt: integer("created_at").notNull(),
		expiresAt: integer("expires_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.mailboxId, t.hash] }),
		index("blobs_expires_at").on(t.expiresAt),
	],
);

export const blobDeliveries = sqliteTable(
	"blob_deliveries",
	{
		mailboxId: text("mailbox_id").notNull(),
		hash: text("hash").notNull(),
		member: text("member").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.mailboxId, t.hash, t.member] }),
		index("blob_deliveries_member").on(t.mailboxId, t.member),
		foreignKey({
			columns: [t.mailboxId, t.hash],
			foreignColumns: [blobs.mailboxId, blobs.hash],
		}).onDelete("cascade"),
		foreignKey({
			columns: [t.mailboxId, t.member],
			foreignColumns: [members.mailboxId, members.sigKey],
		}).onDelete("cascade"),
	],
);

export const blobWants = sqliteTable(
	"blob_wants",
	{
		mailboxId: text("mailbox_id").notNull(),
		member: text("member").notNull(),
		hash: text("hash").notNull(),
		createdAt: integer("created_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.mailboxId, t.member, t.hash] }),
		foreignKey({
			columns: [t.mailboxId, t.member],
			foreignColumns: [members.mailboxId, members.sigKey],
		}).onDelete("cascade"),
	],
);

export const expiryMarkers = sqliteTable(
	"expiry_markers",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		mailboxId: text("mailbox_id").notNull(),
		member: text("member").notNull(),
		sender: text("sender").notNull(),
		count: integer("count").notNull(),
		expiredAt: integer("expired_at").notNull(),
	},
	(t) => [
		index("expiry_markers_member").on(t.mailboxId, t.member),
		foreignKey({
			columns: [t.mailboxId, t.member],
			foreignColumns: [members.mailboxId, members.sigKey],
		}).onDelete("cascade"),
	],
);
