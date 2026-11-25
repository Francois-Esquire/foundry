use std::path::PathBuf;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, OptionalExtension, Row, params};

use super::storage::{GenerationChange, GenerationRow, Storage};
use super::{GenerationRecord, GenerationState, StoreError, StoredWorkspace};
use crate::Layout;

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const WAL: &str = "wal";

pub(super) struct SqliteStorage {
    connection: Connection,
}

impl SqliteStorage {
    pub(super) fn open(layout: &Layout) -> Result<Self, StoreError> {
        Ok(Self {
            connection: connect(&layout.database)?,
        })
    }
}

fn connect(database: &std::path::Path) -> Result<Connection, StoreError> {
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_URI;
    let connection = Connection::open_with_flags(database, flags).map_err(StoreError::failed)?;
    connection
        .busy_timeout(BUSY_TIMEOUT)
        .map_err(StoreError::failed)?;
    let mode: String = connection
        .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))
        .map_err(StoreError::failed)?;
    if !mode.eq_ignore_ascii_case(WAL) {
        return Err(StoreError::Failed(format!(
            "the database at {} keeps a {mode} journal, not a write-ahead log",
            database.display()
        )));
    }
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(StoreError::failed)?;
    Ok(connection)
}

fn workspace_of(row: &Row<'_>) -> rusqlite::Result<StoredWorkspace> {
    Ok(StoredWorkspace {
        id: row.get("id")?,
        root: PathBuf::from(row.get::<_, String>("root")?),
        config: row.get::<_, Option<String>>("config")?.map(PathBuf::from),
        hosted: row.get("hosted")?,
    })
}

fn number_of(number: u64) -> Result<i64, StoreError> {
    i64::try_from(number).map_err(StoreError::failed)
}

fn conversion_failure(
    index: usize,
    error: Box<dyn std::error::Error + Send + Sync>,
) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(index, rusqlite::types::Type::Text, error)
}

fn record_of(row: &Row<'_>) -> rusqlite::Result<GenerationRecord> {
    let state: String = row.get("state")?;
    let workspaces: String = row.get("workspaces")?;
    let state = GenerationState::parse(&state).ok_or_else(|| {
        conversion_failure(4, format!("{state:?} is not a generation state").into())
    })?;
    let workspaces = serde_json::from_str(&workspaces)
        .map_err(|error| conversion_failure(6, Box::new(error)))?;
    Ok(GenerationRecord {
        number: row.get("number")?,
        fingerprint: row.get("fingerprint")?,
        pid: row.get("pid")?,
        started: row.get("started")?,
        state,
        error: row.get("error")?,
        workspaces,
    })
}

impl Storage for SqliteStorage {
    fn hosted_workspaces(&mut self) -> Result<Vec<StoredWorkspace>, StoreError> {
        let mut statement = self
            .connection
            .prepare_cached(
                "SELECT id, root, config, hosted FROM marbles_workspaces WHERE hosted = 1 ORDER BY id",
            )
            .map_err(StoreError::failed)?;
        statement
            .query_map([], workspace_of)
            .and_then(Iterator::collect)
            .map_err(StoreError::failed)
    }

    fn workspace(&mut self, id: &str) -> Result<Option<StoredWorkspace>, StoreError> {
        self.connection
            .query_row(
                "SELECT id, root, config, hosted FROM marbles_workspaces WHERE id = ?1",
                [id],
                workspace_of,
            )
            .optional()
            .map_err(StoreError::failed)
    }

    fn touch_workspace(&mut self, workspace: &StoredWorkspace, at: &str) -> Result<(), StoreError> {
        let root = workspace.root.display().to_string();
        let config = workspace
            .config
            .as_ref()
            .map(|config| config.display().to_string());
        self.connection
            .execute(
                "INSERT INTO marbles_workspaces (config, cwd, first_seen, hosted, id, last_seen, root) \
                 VALUES (?1, NULL, ?2, ?3, ?4, ?2, ?5) \
                 ON CONFLICT (id) DO UPDATE SET config = excluded.config, last_seen = excluded.last_seen, \
                 root = excluded.root, hosted = excluded.hosted",
                params![config, at, workspace.hosted, workspace.id, root],
            )
            .map(drop)
            .map_err(StoreError::failed)
    }

    fn unhost_workspace(&mut self, id: &str) -> Result<bool, StoreError> {
        self.connection
            .execute(
                "UPDATE marbles_workspaces SET hosted = 0 WHERE id = ?1 AND hosted = 1",
                [id],
            )
            .map(|changed| changed > 0)
            .map_err(StoreError::failed)
    }

    fn insert_generation(&mut self, fingerprint: &str, at: &str) -> Result<u64, StoreError> {
        let number: i64 = self
            .connection
            .query_row(
                "INSERT INTO marbles_generations (created_at, fingerprint, pid, state, updated_at) \
                 VALUES (?1, ?2, 0, 'loading', ?1) RETURNING number",
                params![at, fingerprint],
                |row| row.get(0),
            )
            .map_err(StoreError::failed)?;
        u64::try_from(number).map_err(StoreError::failed)
    }

    fn update_generation(
        &mut self,
        number: u64,
        change: &GenerationChange,
        at: &str,
    ) -> Result<(), StoreError> {
        let number = number_of(number)?;
        let updated = match change {
            GenerationChange::Spawned { pid, started } => self.connection.execute(
                "UPDATE marbles_generations SET pid = ?1, started = ?2, updated_at = ?3 WHERE number = ?4",
                params![pid, started, at, number],
            ),
            GenerationChange::Identified { pid, started } => self.connection.execute(
                "UPDATE marbles_generations SET pid = ?1, started = ?2, updated_at = ?3 WHERE number = ?4",
                params![pid, started, at, number],
            ),
            GenerationChange::Hosting(workspaces) => {
                let workspaces = serde_json::to_string(workspaces).map_err(StoreError::failed)?;
                self.connection.execute(
                    "UPDATE marbles_generations SET workspaces = ?1, updated_at = ?2 WHERE number = ?3",
                    params![workspaces, at, number],
                )
            }
            GenerationChange::State { state, error } => self.connection.execute(
                "UPDATE marbles_generations SET state = ?1, error = COALESCE(?2, error), updated_at = ?3 \
                 WHERE number = ?4",
                params![state.as_str(), error, at, number],
            ),
        };
        updated.map(drop).map_err(StoreError::failed)
    }

    fn generation(&mut self, number: u64) -> Result<Option<GenerationRecord>, StoreError> {
        self.connection
            .query_row(
                "SELECT number, fingerprint, pid, started, state, error, workspaces \
                 FROM marbles_generations WHERE number = ?1",
                [number_of(number)?],
                record_of,
            )
            .optional()
            .map_err(StoreError::failed)
    }

    fn generations_in(
        &mut self,
        states: &[GenerationState],
    ) -> Result<Vec<GenerationRow>, StoreError> {
        let names: Vec<&str> = states.iter().map(|state| state.as_str()).collect();
        let names = serde_json::to_string(&names).map_err(StoreError::failed)?;
        let mut statement = self
            .connection
            .prepare_cached(
                "SELECT number, pid, started FROM marbles_generations \
                 WHERE state IN (SELECT value FROM json_each(?1)) ORDER BY number",
            )
            .map_err(StoreError::failed)?;
        let rows: Vec<(i64, i64, Option<String>)> = statement
            .query_map([names], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .and_then(Iterator::collect)
            .map_err(StoreError::failed)?;
        rows.into_iter()
            .map(|(number, pid, started)| {
                Ok(GenerationRow {
                    number: u64::try_from(number).map_err(StoreError::failed)?,
                    pid,
                    started,
                })
            })
            .collect()
    }

    fn queued_bodies(&mut self, scope: &str) -> Result<Vec<String>, StoreError> {
        let mut statement = self
            .connection
            .prepare_cached("SELECT body FROM queue_runs WHERE scope = ?1 AND state = 'queued'")
            .map_err(StoreError::failed)?;
        statement
            .query_map([scope], |row| row.get(0))
            .and_then(Iterator::collect)
            .map_err(StoreError::failed)
    }

    fn run_body(&mut self, scope: &str, run_id: &str) -> Result<Option<String>, StoreError> {
        self.connection
            .query_row(
                "SELECT body FROM queue_runs WHERE scope = ?1 AND id = ?2",
                [scope, run_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(StoreError::failed)
    }
}
