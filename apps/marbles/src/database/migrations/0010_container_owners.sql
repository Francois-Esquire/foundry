CREATE TABLE `marbles_container_owners` (
	`container_id` text NOT NULL,
	`owner_pid` integer NOT NULL,
	`owner_started` text NOT NULL,
	`scope` text NOT NULL,
	PRIMARY KEY(`scope`, `container_id`)
);
