CREATE TABLE `appRecords` (
	`id` varchar(191) NOT NULL,
	`kind` varchar(48) NOT NULL,
	`ownerId` int NOT NULL,
	`payload` json NOT NULL,
	`revision` int NOT NULL DEFAULT 1,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `appRecords_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `appRecords_kind_owner` ON `appRecords` (`kind`,`ownerId`);