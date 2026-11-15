CREATE TABLE `marbles_generations` (
	`created_at` text NOT NULL,
	`error` text,
	`fingerprint` text NOT NULL,
	`number` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pid` integer NOT NULL,
	`started` text,
	`state` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `marbles_generations_state_idx` ON `marbles_generations` (`state`);