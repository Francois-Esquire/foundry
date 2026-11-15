CREATE TABLE `agent_messages` (
	`created_at` integer NOT NULL,
	`id` text NOT NULL,
	`metadata` text,
	`parts` text NOT NULL,
	`position` integer NOT NULL,
	`role` text NOT NULL,
	`scope` text NOT NULL,
	`session_id` text NOT NULL,
	`status` text NOT NULL,
	`summarized` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE INDEX `agent_messages_scope_session_position` ON `agent_messages` (`scope`,`session_id`,`position`);--> statement-breakpoint
CREATE TABLE `agent_sessions` (
	`created_at` integer NOT NULL,
	`id` text NOT NULL,
	`parent_message_id` text,
	`parent_session_id` text,
	`recursion_depth` integer,
	`scope` text NOT NULL,
	`status` text NOT NULL,
	`title` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE TABLE `marbles_session_revisions` (
	`revision` integer NOT NULL,
	`scope` text NOT NULL,
	`session_id` text NOT NULL,
	PRIMARY KEY(`scope`, `session_id`)
);
