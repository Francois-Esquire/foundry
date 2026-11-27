use rusqlite::{Connection, params};
use serde_json::Value;

use crate::Layout;

const TABLES: &str = "
CREATE TABLE `marbles_workspaces` (
	`config` text,
	`cwd` text,
	`first_seen` text NOT NULL,
	`hosted` integer DEFAULT false NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`last_seen` text NOT NULL,
	`root` text NOT NULL
);
CREATE TABLE `marbles_generations` (
	`created_at` text NOT NULL,
	`error` text,
	`fingerprint` text NOT NULL,
	`number` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pid` integer NOT NULL,
	`started` text,
	`state` text NOT NULL,
	`updated_at` text NOT NULL,
	`workspaces` text DEFAULT '[]' NOT NULL
);
CREATE INDEX `marbles_generations_state_idx` ON `marbles_generations` (`state`);
CREATE TABLE `queue_runs` (
	`body` text NOT NULL,
	`id` text NOT NULL,
	`job_id` text NOT NULL,
	`scope` text NOT NULL,
	`state` text NOT NULL,
	PRIMARY KEY(`scope`, `id`)
);
";

pub(crate) fn create(layout: &Layout) -> Connection {
    std::fs::create_dir_all(&layout.state).expect("the state root");
    let connection = Connection::open(&layout.database).expect("a database");
    connection.execute_batch(TABLES).expect("the tables");
    connection
}

pub(crate) fn put_queue_run(connection: &Connection, scope: &str, body: &Value) {
    let id = body["id"].as_str().expect("a run id");
    let state = body["state"]["kind"].as_str().expect("a run state");
    connection
        .execute(
            "INSERT OR REPLACE INTO queue_runs (body, id, job_id, scope, state) VALUES (?1, ?2, 'job', ?3, ?4)",
            params![body.to_string(), id, scope, state],
        )
        .expect("the queue run");
}
