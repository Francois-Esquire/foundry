use std::io;
use std::path::PathBuf;

use tokio::sync::{mpsc, oneshot};

use crate::Layout;
use crate::identity::ProcessIdentity;
use crate::protocol::NonEmptyString;

const TOKEN_BYTES: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnSpec {
    pub number: u64,
    pub token: NonEmptyString,
    pub socket: PathBuf,
    pub layout: Layout,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GenerationExit {
    pub clean: bool,
    pub reason: String,
}

#[derive(Debug)]
pub struct SpawnedGeneration {
    pub pid: Option<u32>,
    pub spawned_as: Option<ProcessIdentity>,
    pub exited: oneshot::Receiver<GenerationExit>,
    pub lines: mpsc::Receiver<String>,
}

pub trait GenerationLauncher: Send + Sync + 'static {
    fn spawn(&self, spec: SpawnSpec) -> Result<SpawnedGeneration, io::Error>;
}

pub(super) fn registration_token() -> io::Result<NonEmptyString> {
    let mut bytes = [0_u8; TOKEN_BYTES];
    getrandom::fill(&mut bytes).map_err(|error| io::Error::other(error.to_string()))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    let uuid = format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    );
    NonEmptyString::try_from(uuid).map_err(|error| io::Error::other(error.to_string()))
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn tokens_are_random_version_four_uuids() {
        let tokens: HashSet<String> = (0..64)
            .map(|_| registration_token().expect("a token").as_str().to_owned())
            .collect();

        assert_eq!(tokens.len(), 64);
        for token in &tokens {
            let groups: Vec<&str> = token.split('-').collect();
            assert_eq!(
                groups.iter().map(|group| group.len()).collect::<Vec<_>>(),
                [8, 4, 4, 4, 12]
            );
            assert!(token.bytes().all(|byte| byte == b'-'
                || byte.is_ascii_digit()
                || (b'a'..=b'f').contains(&byte)));
            assert!(groups[2].starts_with('4'));
            assert!(matches!(
                groups[3].chars().next(),
                Some('8' | '9' | 'a' | 'b')
            ));
        }
    }
}
