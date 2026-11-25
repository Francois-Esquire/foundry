use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};

use tokio::time::Instant;

use super::launcher::GenerationExit;
use crate::channel::ChannelHandle;
use crate::fingerprint::Fingerprint;
use crate::identity::ProcessIdentity;
use crate::protocol::NonEmptyString;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GenerationRole {
    Candidate,
    Current,
    Retiring,
}

#[derive(Debug)]
pub(super) struct Generation {
    pub(super) number: u64,
    pub(super) token: NonEmptyString,
    pub(super) role: GenerationRole,
    pub(super) pid: Option<u32>,
    pub(super) identity: Option<ProcessIdentity>,
    pub(super) spawned_as: Option<ProcessIdentity>,
    pub(super) channel: Option<ChannelHandle>,
    pub(super) hosts: BTreeSet<String>,
    pub(super) fingerprint: Fingerprint,
    pub(super) became_current_at: Option<Instant>,
    pub(super) start_settled: bool,
    pub(super) exit: Option<GenerationExit>,
    pub(super) processed_notifications: u64,
    pub(super) in_flight_reads: usize,
}

impl Generation {
    pub(super) fn candidate(number: u64, token: NonEmptyString, fingerprint: Fingerprint) -> Self {
        Self {
            number,
            token,
            role: GenerationRole::Candidate,
            pid: None,
            identity: None,
            spawned_as: None,
            channel: None,
            hosts: BTreeSet::new(),
            fingerprint,
            became_current_at: None,
            start_settled: false,
            exit: None,
            processed_notifications: 0,
            in_flight_reads: 0,
        }
    }

    pub(super) fn is_live(&self) -> bool {
        self.exit.is_none()
    }

    pub(super) fn open_channel(&self) -> Option<ChannelHandle> {
        self.channel
            .as_ref()
            .filter(|channel| self.is_live() && !channel.is_closed())
            .cloned()
    }

    pub(super) fn shown_pid(&self) -> Option<u32> {
        self.pid
            .or_else(|| self.identity.as_ref().map(|identity| identity.pid))
    }

    pub(super) fn provable_identity(&self) -> Option<ProcessIdentity> {
        let spawned = self
            .spawned_as
            .as_ref()
            .filter(|spawned| spawned.started.is_some());
        spawned.or(self.identity.as_ref()).cloned()
    }
}

#[derive(Debug, Default)]
pub(super) struct Generations {
    by_number: BTreeMap<u64, Generation>,
    pub(super) current: Option<u64>,
}

impl Generations {
    pub(super) fn insert(&mut self, generation: Generation) {
        self.by_number.insert(generation.number, generation);
    }

    pub(super) fn remove(&mut self, number: u64) {
        self.by_number.remove(&number);
    }

    pub(super) fn get(&self, number: u64) -> Option<&Generation> {
        self.by_number.get(&number)
    }

    pub(super) fn get_mut(&mut self, number: u64) -> Option<&mut Generation> {
        self.by_number.get_mut(&number)
    }

    pub(super) fn current(&self) -> Option<&Generation> {
        self.current.and_then(|number| self.get(number))
    }

    pub(super) fn is_current(&self, number: u64) -> bool {
        self.current == Some(number)
    }

    pub(super) fn is_live(&self, number: u64) -> bool {
        self.get(number).is_some_and(Generation::is_live)
    }

    pub(super) fn exit_reason(&self, number: u64) -> Option<String> {
        match self.get(number) {
            None => Some(format!("engine generation {number} is gone")),
            Some(generation) => generation.exit.as_ref().map(|exit| exit.reason.clone()),
        }
    }

    pub(super) fn start_settled(&self, number: u64) -> bool {
        self.get(number)
            .is_none_or(|generation| generation.start_settled || !generation.is_live())
    }

    pub(super) fn register(
        &mut self,
        token: &NonEmptyString,
        channel: ChannelHandle,
    ) -> Result<u64, String> {
        let generation = self
            .by_number
            .values_mut()
            .find(|generation| generation.is_live() && generation.token == *token)
            .ok_or_else(|| "no engine generation was spawned with this token".to_owned())?;
        if generation.channel.is_some() {
            return Err(format!(
                "engine generation {} has registered already",
                generation.number
            ));
        }
        generation.channel = Some(channel);
        Ok(generation.number)
    }

    pub(super) fn hosts_of(&self, id: &str) -> Vec<u64> {
        let mut hosting: Vec<u64> = self
            .by_number
            .values()
            .filter(|generation| {
                generation.role != GenerationRole::Candidate
                    && generation.is_live()
                    && generation.hosts.contains(id)
            })
            .map(|generation| generation.number)
            .collect();
        hosting.sort_by_key(|number| (!self.is_current(*number), Reverse(*number)));
        hosting
    }

    pub(super) fn live(&self) -> Vec<u64> {
        self.by_number
            .values()
            .filter(|generation| generation.is_live())
            .map(|generation| generation.number)
            .collect()
    }

    pub(super) fn channels(&self) -> Vec<ChannelHandle> {
        self.by_number
            .values()
            .filter_map(|generation| generation.channel.clone())
            .collect()
    }

    pub(super) fn prune_exited(&mut self) {
        self.by_number.retain(|_, generation| generation.is_live());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(text: &str) -> NonEmptyString {
        NonEmptyString::try_from(text.to_owned()).expect("a token")
    }

    fn blank() -> Fingerprint {
        Fingerprint::of("", std::collections::BTreeMap::new())
    }

    fn table() -> Generations {
        let mut generations = Generations::default();
        for (number, role) in [
            (1, GenerationRole::Retiring),
            (2, GenerationRole::Retiring),
            (3, GenerationRole::Current),
            (4, GenerationRole::Candidate),
        ] {
            let mut generation =
                Generation::candidate(number, token(&format!("t{number}")), blank());
            generation.role = role;
            generation.hosts.insert("w1".to_owned());
            generations.insert(generation);
        }
        generations.current = Some(3);
        generations
    }

    #[test]
    fn hosts_are_the_current_generation_then_the_newest_retiring_ones() {
        assert_eq!(table().hosts_of("w1"), [3, 2, 1]);
        assert!(table().hosts_of("w2").is_empty());
    }

    #[test]
    fn exited_generations_host_nothing_and_report_why() {
        let mut generations = table();
        if let Some(generation) = generations.get_mut(2) {
            generation.exit = Some(GenerationExit {
                clean: true,
                reason: "exit 0".to_owned(),
            });
        }

        assert_eq!(generations.hosts_of("w1"), [3, 1]);
        assert_eq!(generations.exit_reason(2).as_deref(), Some("exit 0"));
        generations.prune_exited();
        assert_eq!(
            generations.exit_reason(2).as_deref(),
            Some("engine generation 2 is gone")
        );
        assert_eq!(generations.exit_reason(3), None);
    }

    #[test]
    fn identities_are_proved_through_their_spawn_when_it_was_read() {
        let read = ProcessIdentity {
            pid: 7,
            started: Some("ps:a".to_owned()),
        };
        let unread = ProcessIdentity {
            pid: 7,
            started: None,
        };
        let reported = ProcessIdentity {
            pid: 7,
            started: Some("ps:b".to_owned()),
        };
        let mut generation = Generation::candidate(1, token("t"), blank());
        generation.spawned_as = Some(read.clone());
        generation.identity = Some(reported.clone());

        assert_eq!(generation.provable_identity(), Some(read));
        generation.spawned_as = Some(unread);
        assert_eq!(generation.provable_identity(), Some(reported));
    }
}
