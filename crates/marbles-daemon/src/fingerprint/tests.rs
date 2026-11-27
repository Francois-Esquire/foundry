use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use super::*;

const AT: u64 = 1_000_000_000;

struct Repo {
    _dir: tempfile::TempDir,
    _outside: tempfile::TempDir,
    root: PathBuf,
    outside: PathBuf,
}

fn repo() -> Repo {
    let dir = tempfile::tempdir().expect("a workspace");
    let outside = tempfile::tempdir().expect("an outside directory");
    let root = fs::canonicalize(dir.path()).expect("the root");
    let far = fs::canonicalize(outside.path()).expect("the outside root");
    write(&root, "flow.ts", "export {}", AT - 10);
    write(&far, "shared.ts", "export const shared = 1", AT - 10);
    Repo {
        _dir: dir,
        _outside: outside,
        root,
        outside: far,
    }
}

fn write(root: &Path, relative: &str, bytes: &str, modified_ms: u64) {
    let path = root.join(relative);
    fs::write(&path, bytes).expect("the file");
    File::options()
        .write(true)
        .open(&path)
        .expect("the file")
        .set_modified(UNIX_EPOCH + Duration::from_millis(modified_ms))
        .expect("the modification time");
}

fn registration(repo: &Repo) -> WorkspaceRegistration {
    WorkspaceRegistration {
        id: "w1".to_owned(),
        root: repo.root.clone(),
        config: None,
    }
}

fn print_of(repo: &Repo, outside: &[String], digests: &mut FileDigests) -> WorkspacePrint {
    print_now(
        &registration(repo),
        outside,
        digests,
        &HashSet::new(),
        TREE_LIMIT,
    )
}

fn fingerprint(print: WorkspacePrint) -> Fingerprint {
    Fingerprint::of("install", BTreeMap::from([("w1".to_owned(), print)]))
}

fn shared(repo: &Repo) -> String {
    repo.outside.join("shared.ts").display().to_string()
}

#[test]
fn a_print_is_stable_until_a_file_under_the_root_changes() {
    let repo = repo();
    let mut digests = FileDigests::default();
    let first = fingerprint(print_of(&repo, &[], &mut digests));

    assert_eq!(fingerprint(print_of(&repo, &[], &mut digests)), first);

    write(&repo.root, "flow.ts", "export const changed = 1", AT);
    let changed = fingerprint(print_of(&repo, &[], &mut digests));
    assert_ne!(changed.digest, first.digest);
    assert!(first.edited(&changed, "w1"));
    assert!(!changed.edited(&changed, "w1"));
}

#[test]
fn a_file_read_outside_the_root_joins_the_print_as_it_was_when_read() {
    let repo = repo();
    let mut digests = FileDigests::default();
    let print = print_of(&repo, &[], &mut digests);

    let read = print
        .with_read(&shared(&repo), AT, &mut digests)
        .expect("the outside read is recorded");

    let expected = digests.of(&repo.outside.join("shared.ts"));
    assert_eq!(read.outside.get(&shared(&repo)), expected.as_ref());
    assert_eq!(read.with_read(&shared(&repo), AT, &mut digests), None);
    let inside = repo.root.join("flow.ts").display().to_string();
    assert_eq!(print.with_read(&inside, AT, &mut digests), None);
}

#[test]
fn a_file_modified_after_it_was_read_is_marked_changed() {
    let repo = repo();
    let mut digests = FileDigests::default();
    let print = print_of(&repo, &[], &mut digests);
    write(
        &repo.outside,
        "shared.ts",
        "export const shared = 2",
        AT + 5,
    );

    let read = print
        .with_read(&shared(&repo), AT, &mut digests)
        .expect("the outside read is recorded");

    assert_eq!(
        read.outside.get(&shared(&repo)).map(String::as_str),
        Some("changed since it was read")
    );
    let missing = repo.outside.join("gone.ts").display().to_string();
    let gone = print
        .with_read(&missing, AT, &mut digests)
        .expect("a missing read is recorded");
    assert_eq!(
        gone.outside.get(&missing).map(String::as_str),
        Some("changed since it was read")
    );
}

#[test]
fn files_read_outside_are_watched_again_and_restored_edits_count() {
    let repo = repo();
    let mut digests = FileDigests::default();
    let outside = [shared(&repo)];
    let loaded = print_of(&repo, &outside, &mut digests);

    write(
        &repo.outside,
        "shared.ts",
        "export const shared = 2;",
        AT + 5,
    );
    let now = print_of(&repo, &outside, &mut digests);

    assert_ne!(fingerprint(now).digest, fingerprint(loaded).digest);
}

#[test]
fn a_refused_candidate_keeps_watching_what_the_previous_generation_read() {
    let repo = repo();
    let mut digests = FileDigests::default();
    let watched = fingerprint(print_of(&repo, &[shared(&repo)], &mut digests));
    let candidate = fingerprint(print_of(&repo, &[], &mut digests));

    let refused = candidate.watching(Some(&watched));

    assert_eq!(refused.sources["w1"].outside, watched.sources["w1"].outside);
    assert_eq!(refused.digest, watched.digest);
    assert_eq!(candidate.watching(None), candidate);
}

#[test]
fn differences_name_the_installation_and_every_changed_path() {
    let repo = repo();
    let mut digests = FileDigests::default();
    let was = fingerprint(print_of(&repo, &[], &mut digests));
    write(&repo.root, "flow.ts", "export const changed = 1", AT);
    write(&repo.root, "added.json", "{}", AT);
    let print = print_of(&repo, &[], &mut digests);
    let now = Fingerprint::of(
        "upgraded",
        BTreeMap::from([
            ("w1".to_owned(), print),
            ("w2".to_owned(), was.sources["w1"].clone()),
        ]),
    );

    let lines = differences(&was, &now);

    let flow_was = &was.sources["w1"].files["flow.ts"];
    let flow_now = &now.sources["w1"].files["flow.ts"];
    let added = &now.sources["w1"].files["added.json"];
    assert_eq!(
        lines,
        [
            "the installation changed".to_owned(),
            format!("workspace w1: added.json under its root (absent → {added})"),
            format!("workspace w1: flow.ts under its root ({flow_was} → {flow_now})"),
            "workspace w2 added".to_owned(),
        ]
    );
    assert_eq!(
        differences(&now, &was.with_source("w1", None)),
        [
            "the installation changed".to_owned(),
            "workspace w1 removed".to_owned(),
            "workspace w2 removed".to_owned(),
        ]
    );
}

#[test]
fn the_state_root_and_artifacts_are_ignored_raw_and_canonical() {
    let home = tempfile::tempdir().expect("a home");
    let layout = crate::Layout::from_home(home.path());
    fs::create_dir_all(&layout.state).expect("the state root");

    let ignored = ignored_paths(&layout);

    assert!(ignored.contains(&layout.home));
    assert!(ignored.contains(&layout.state));
    assert!(ignored.contains(&layout.artifacts));
    assert!(ignored.contains(&fs::canonicalize(&layout.state).expect("canonical")));
}
