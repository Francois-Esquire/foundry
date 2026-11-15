CREATE TABLE `artifact_blob_chunks` (
	`blob_id` text NOT NULL,
	`chunk_id` text NOT NULL,
	`scope` text NOT NULL,
	PRIMARY KEY(`scope`, `chunk_id`, `blob_id`)
);
--> statement-breakpoint
CREATE INDEX `artifact_blob_chunks_scope_blob` ON `artifact_blob_chunks` (`scope`,`blob_id`);--> statement-breakpoint
CREATE TABLE `artifact_blobs` (
	`byte_length` integer NOT NULL,
	`bytes` blob,
	`chunks` text,
	`created_at` integer NOT NULL,
	`digest` text NOT NULL,
	`id` text NOT NULL,
	`path` text,
	`scope` text NOT NULL,
	PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE INDEX `artifact_blobs_scope_digest` ON `artifact_blobs` (`scope`,`digest`);--> statement-breakpoint
CREATE TABLE `artifact_content_blobs` (
	`blob_id` text NOT NULL,
	`content_id` text NOT NULL,
	`scope` text NOT NULL,
	PRIMARY KEY(`scope`, `blob_id`, `content_id`)
);
--> statement-breakpoint
CREATE INDEX `artifact_content_blobs_scope_content` ON `artifact_content_blobs` (`scope`,`content_id`);--> statement-breakpoint
CREATE TABLE `artifact_contents` (
	`artifact_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`digest` text NOT NULL,
	`frozen_at` integer,
	`id` text NOT NULL,
	`metadata` text NOT NULL,
	`scope` text NOT NULL,
	`state` text NOT NULL,
	`tag` text,
	`tree` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE INDEX `artifact_contents_scope_artifact` ON `artifact_contents` (`scope`,`artifact_id`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`archived_at` integer,
	`content_id` text,
	`created_at` integer NOT NULL,
	`id` text NOT NULL,
	`id_lower` text NOT NULL,
	`id_order` blob NOT NULL,
	`metadata` text NOT NULL,
	`name` text NOT NULL,
	`name_lower` text NOT NULL,
	`published_at` integer,
	`scope` text NOT NULL,
	`status` text NOT NULL,
	`text_units` text NOT NULL,
	`type` text NOT NULL,
	`type_lower` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE INDEX `artifacts_scope_created` ON `artifacts` (`scope`,`created_at`,`id_order`);--> statement-breakpoint
CREATE INDEX `artifacts_scope_type_created` ON `artifacts` (`scope`,`type`,`created_at`,`id_order`);--> statement-breakpoint
CREATE TABLE `module_installations` (
	`container_id` text,
	`content_id` text NOT NULL,
	`created_at` text NOT NULL,
	`generation` integer NOT NULL,
	`grants` text NOT NULL,
	`id` text NOT NULL,
	`module_id` text NOT NULL,
	`position` integer NOT NULL,
	`scope` text NOT NULL,
	`start_attempts` integer NOT NULL,
	`status` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE INDEX `module_installations_scope_position` ON `module_installations` (`scope`,`position`);--> statement-breakpoint
CREATE INDEX `module_installations_scope_module` ON `module_installations` (`scope`,`module_id`,`position`);--> statement-breakpoint
CREATE TABLE `module_manifests` (
	`content_id` text NOT NULL,
	`manifest` text NOT NULL,
	`module_id` text NOT NULL,
	`position` integer NOT NULL,
	`scope` text NOT NULL,
	PRIMARY KEY(`scope`, `content_id`)
);
--> statement-breakpoint
CREATE INDEX `module_manifests_scope_position` ON `module_manifests` (`scope`,`position`);--> statement-breakpoint
CREATE TABLE `module_positions` (
	`next` integer NOT NULL,
	`scope` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `modules` (
	`artifact_id` text NOT NULL,
	`id` text NOT NULL,
	`position` integer NOT NULL,
	`scope` text NOT NULL,
	PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE INDEX `modules_scope_position` ON `modules` (`scope`,`position`);--> statement-breakpoint
CREATE INDEX `modules_scope_artifact` ON `modules` (`scope`,`artifact_id`);--> statement-breakpoint
CREATE TABLE `sandbox_containers` (
	`created_at` integer NOT NULL,
	`id` text NOT NULL,
	`native_id` text,
	`position` integer NOT NULL,
	`scope` text NOT NULL,
	`spec` text NOT NULL,
	`status` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE INDEX `sandbox_containers_scope_position` ON `sandbox_containers` (`scope`,`position`);--> statement-breakpoint
CREATE TABLE `workflow_jobs` (
	`definition` text NOT NULL,
	`id` text NOT NULL,
	`input` text,
	`links` text NOT NULL,
	`position` integer NOT NULL,
	`scope` text NOT NULL,
	`status` text NOT NULL,
	`timestamps` text NOT NULL,
	PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE INDEX `workflow_jobs_scope_position` ON `workflow_jobs` (`scope`,`position`);--> statement-breakpoint
CREATE TABLE `workflow_positions` (
	`next` integer NOT NULL,
	`scope` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workflow_queues` (
	`created_at` integer NOT NULL,
	`extensions` text NOT NULL,
	`id` text NOT NULL,
	`last_error` text,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`scope` text NOT NULL,
	`status` text NOT NULL,
	PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE INDEX `workflow_queues_scope_position` ON `workflow_queues` (`scope`,`position`);--> statement-breakpoint
CREATE TABLE `workflow_run_frames` (
	`at` integer NOT NULL,
	`cursor` integer NOT NULL,
	`payload` text NOT NULL,
	`position` integer NOT NULL,
	`run_id` text NOT NULL,
	`scope` text NOT NULL,
	PRIMARY KEY(`scope`, `run_id`, `cursor`)
);
--> statement-breakpoint
CREATE INDEX `workflow_run_frames_scope_position` ON `workflow_run_frames` (`scope`,`position`);--> statement-breakpoint
CREATE INDEX `workflow_run_frames_scope_run_position` ON `workflow_run_frames` (`scope`,`run_id`,`position`);--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`definition` text,
	`error` text,
	`extensions` text NOT NULL,
	`id` text NOT NULL,
	`input` text,
	`links` text,
	`metadata` text NOT NULL,
	`output` text,
	`position` integer NOT NULL,
	`queue_id` text NOT NULL,
	`scope` text NOT NULL,
	`snapshot` text NOT NULL,
	`status` text NOT NULL,
	`step` text NOT NULL,
	`tags` text NOT NULL,
	`timestamps` text NOT NULL,
	`undeclared` text,
	PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE INDEX `workflow_runs_scope_position` ON `workflow_runs` (`scope`,`position`);--> statement-breakpoint
CREATE TABLE `workflow_suspensions` (
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`occurrence` integer NOT NULL,
	`position` integer NOT NULL,
	`reason` text NOT NULL,
	`request` text,
	`resolution` text,
	`revision` integer NOT NULL,
	`run_id` text NOT NULL,
	`scope` text NOT NULL,
	`status` text NOT NULL,
	`step_path` text NOT NULL,
	`timestamps` text NOT NULL,
	PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE INDEX `workflow_suspensions_scope_position` ON `workflow_suspensions` (`scope`,`position`);--> statement-breakpoint
CREATE INDEX `workflow_suspensions_scope_run_position` ON `workflow_suspensions` (`scope`,`run_id`,`position`);--> statement-breakpoint
CREATE TABLE `workspace_entries` (
	`bytes` integer,
	`created_at` integer NOT NULL,
	`digest` text,
	`extension` text,
	`id` text NOT NULL,
	`kind` text,
	`mime` text,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`scope` text NOT NULL,
	`target` text,
	`type` text NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace_id` text NOT NULL,
	PRIMARY KEY(`scope`, `workspace_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`created_at` integer NOT NULL,
	`id` text NOT NULL,
	`last_reconciled_at` integer NOT NULL,
	`name` text NOT NULL,
	`scope` text NOT NULL,
	`source_id` text,
	`source_kind` text NOT NULL,
	`source_path` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE INDEX `workspaces_scope_created` ON `workspaces` (`scope`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `workspaces_scope_source_path` ON `workspaces` (`scope`,`source_path`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `workspaces_scope_source_id` ON `workspaces` (`scope`,`source_id`,`created_at`,`id`);