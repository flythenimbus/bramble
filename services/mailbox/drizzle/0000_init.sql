CREATE TABLE `blob_deliveries` (
	`mailbox_id` text NOT NULL,
	`hash` text NOT NULL,
	`member` text NOT NULL,
	PRIMARY KEY(`mailbox_id`, `hash`, `member`),
	FOREIGN KEY (`mailbox_id`,`hash`) REFERENCES `blobs`(`mailbox_id`,`hash`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`,`member`) REFERENCES `members`(`mailbox_id`,`sig_key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `blob_deliveries_member` ON `blob_deliveries` (`mailbox_id`,`member`);--> statement-breakpoint
CREATE TABLE `blob_wants` (
	`mailbox_id` text NOT NULL,
	`member` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`mailbox_id`, `member`, `hash`),
	FOREIGN KEY (`mailbox_id`,`member`) REFERENCES `members`(`mailbox_id`,`sig_key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `blobs` (
	`mailbox_id` text NOT NULL,
	`hash` text NOT NULL,
	`size` integer NOT NULL,
	`uploader` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`mailbox_id`, `hash`),
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `blobs_expires_at` ON `blobs` (`expires_at`);--> statement-breakpoint
CREATE TABLE `deliveries` (
	`mailbox_id` text NOT NULL,
	`message_id` text NOT NULL,
	`member` text NOT NULL,
	PRIMARY KEY(`mailbox_id`, `message_id`, `member`),
	FOREIGN KEY (`mailbox_id`,`message_id`) REFERENCES `messages`(`mailbox_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`,`member`) REFERENCES `members`(`mailbox_id`,`sig_key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `deliveries_member` ON `deliveries` (`mailbox_id`,`member`);--> statement-breakpoint
CREATE TABLE `expiry_markers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mailbox_id` text NOT NULL,
	`member` text NOT NULL,
	`sender` text NOT NULL,
	`count` integer NOT NULL,
	`expired_at` integer NOT NULL,
	FOREIGN KEY (`mailbox_id`,`member`) REFERENCES `members`(`mailbox_id`,`sig_key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `expiry_markers_member` ON `expiry_markers` (`mailbox_id`,`member`);--> statement-breakpoint
CREATE TABLE `mailboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`retention_days` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `members` (
	`mailbox_id` text NOT NULL,
	`sig_key` text NOT NULL,
	`status` text NOT NULL,
	`added_at` integer NOT NULL,
	`last_checked_day` integer,
	PRIMARY KEY(`mailbox_id`, `sig_key`),
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`mailbox_id` text NOT NULL,
	`id` text NOT NULL,
	`sender` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`mailbox_id`, `id`),
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_expires_at` ON `messages` (`expires_at`);