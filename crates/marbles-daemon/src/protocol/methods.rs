use std::fmt;
use std::str::FromStr;

use super::{NonEmptyString, ProtocolError};

pub const WORKSPACE_PREFIX: &str = "workspace.";

macro_rules! wire_names {
    (@names $name:ident, $accessor:ident { $($variant:ident => $wire:literal),+ }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum $name {
            $($variant),+
        }

        const _: () = {
            $(assert!(!$wire.is_empty());)+
        };

        impl $name {
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];

            pub const fn $accessor(self) -> &'static str {
                match self {
                    $(Self::$variant => $wire),+
                }
            }
        }

        impl FromStr for $name {
            type Err = ProtocolError;

            fn from_str(name: &str) -> Result<Self, Self::Err> {
                match name {
                    $($wire => Ok(Self::$variant),)+
                    _ => Err(ProtocolError::UnknownMethod(name.to_owned())),
                }
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(self.$accessor())
            }
        }
    };
    ($name:ident { $($variant:ident => $wire:literal),+ $(,)? }) => {
        wire_names!(@names $name, as_str { $($variant => $wire),+ });

        impl From<$name> for NonEmptyString {
            fn from(method: $name) -> Self {
                Self::from_wire_name(method.as_str())
            }
        }
    };
    (prefixed $prefix:literal, $name:ident { $($variant:ident => $wire:literal),+ $(,)? }) => {
        wire_names!(@names $name, local_name { $($variant => $wire),+ });

        impl $name {
            pub const fn wire_name(self) -> &'static str {
                match self {
                    $(Self::$variant => concat!($prefix, $wire)),+
                }
            }
        }

        impl From<$name> for NonEmptyString {
            fn from(method: $name) -> Self {
                Self::from_wire_name(method.wire_name())
            }
        }
    };
}

wire_names!(DaemonMethod {
    Attach => "attach",
    Detach => "detach",
    Hello => "hello",
    Register => "register",
    Reload => "reload",
    Shutdown => "shutdown",
    Subscribe => "subscribe",
    Unsubscribe => "unsubscribe",
    Workspaces => "workspaces",
});

wire_names!(prefixed "workspace.", WorkspaceMethod {
    Answer => "answer",
    Cancel => "cancel",
    CancelRun => "cancelRun",
    DeleteTrigger => "deleteTrigger",
    Describe => "describe",
    DispatchAgent => "dispatchAgent",
    DispatchWorkflow => "dispatchWorkflow",
    GetRun => "getRun",
    Launch => "launch",
    ListRuns => "listRuns",
    Pause => "pause",
    Resume => "resume",
    Roll => "roll",
    Send => "send",
    SetTriggerEnabled => "setTriggerEnabled",
    Snapshot => "snapshot",
    Steer => "steer",
    StopActivity => "stopActivity",
    Tasks => "tasks",
});

wire_names!(GenerationMethod {
    Host => "host",
    LiveWork => "liveWork",
    Load => "load",
    Retire => "retire",
    Start => "start",
    Stop => "stop",
    TakeHanded => "takeHanded",
    TakeQueued => "takeQueued",
    Unhost => "unhost",
});

wire_names!(GenerationNotification {
    Handed => "handed",
    Line => "line",
    Read => "read",
});

wire_names!(ClientNotification {
    Line => "line",
    Workspace => "workspace",
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WorkspaceRoute {
    Owner,
    HostsInTurn,
    CurrentWithLiveWork,
    Current,
}

impl WorkspaceMethod {
    pub fn from_wire_method(method: &str) -> Option<Self> {
        method.strip_prefix(WORKSPACE_PREFIX)?.parse().ok()
    }

    pub const fn route(self) -> WorkspaceRoute {
        match self {
            Self::Cancel
            | Self::CancelRun
            | Self::GetRun
            | Self::Pause
            | Self::Resume
            | Self::Send
            | Self::Steer => WorkspaceRoute::Owner,
            Self::Answer | Self::StopActivity => WorkspaceRoute::HostsInTurn,
            Self::Snapshot => WorkspaceRoute::CurrentWithLiveWork,
            Self::DeleteTrigger
            | Self::Describe
            | Self::DispatchAgent
            | Self::DispatchWorkflow
            | Self::Launch
            | Self::ListRuns
            | Self::Roll
            | Self::SetTriggerEnabled
            | Self::Tasks => WorkspaceRoute::Current,
        }
    }

    pub const fn dispatches_work(self) -> bool {
        matches!(
            self,
            Self::DispatchAgent | Self::DispatchWorkflow | Self::Launch | Self::Resume | Self::Roll
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace_methods_where(
        predicate: impl Fn(WorkspaceMethod) -> bool,
    ) -> Vec<WorkspaceMethod> {
        WorkspaceMethod::ALL
            .iter()
            .copied()
            .filter(|method| predicate(*method))
            .collect()
    }

    #[test]
    fn daemon_methods_roundtrip_through_their_wire_names() {
        for method in DaemonMethod::ALL {
            assert_eq!(method.as_str().parse::<DaemonMethod>().ok(), Some(*method));
        }
        assert_eq!(DaemonMethod::ALL.len(), 9);
    }

    #[test]
    fn generation_methods_use_camel_case_wire_names() {
        assert_eq!(GenerationMethod::LiveWork.as_str(), "liveWork");
        assert_eq!(GenerationMethod::TakeQueued.to_string(), "takeQueued");
        assert_eq!(GenerationMethod::ALL.len(), 9);
    }

    #[test]
    fn notifications_parse_from_their_wire_names() {
        assert_eq!("read".parse().ok(), Some(GenerationNotification::Read));
        assert_eq!(
            "workspace".parse().ok(),
            Some(ClientNotification::Workspace)
        );
    }

    #[test]
    fn unknown_names_are_rejected() {
        assert!(matches!(
            "Hello".parse::<DaemonMethod>(),
            Err(ProtocolError::UnknownMethod(name)) if name == "Hello"
        ));
    }

    #[test]
    fn there_are_nineteen_workspace_methods() {
        assert_eq!(WorkspaceMethod::ALL.len(), 19);
    }

    #[test]
    fn workspace_wire_names_carry_the_prefix_and_roundtrip() {
        for method in WorkspaceMethod::ALL {
            let wire_name = method.wire_name();

            assert_eq!(wire_name, format!("{WORKSPACE_PREFIX}{method}"));
            assert_eq!(
                wire_name,
                format!("{WORKSPACE_PREFIX}{}", method.local_name())
            );
            assert_eq!(WorkspaceMethod::from_wire_method(wire_name), Some(*method));
        }
    }

    #[test]
    fn workspace_methods_require_the_prefix() {
        assert_eq!(WorkspaceMethod::from_wire_method("cancelRun"), None);
        assert_eq!(WorkspaceMethod::from_wire_method("workspace.unknown"), None);
        assert_eq!(
            WorkspaceMethod::from_wire_method("workspace.cancelRun"),
            Some(WorkspaceMethod::CancelRun)
        );
    }

    #[test]
    fn workspace_routes_match_the_daemon() {
        use WorkspaceMethod::*;

        let routed = |route| workspace_methods_where(|method| method.route() == route);

        assert_eq!(
            routed(WorkspaceRoute::Owner),
            [Cancel, CancelRun, GetRun, Pause, Resume, Send, Steer]
        );
        assert_eq!(routed(WorkspaceRoute::HostsInTurn), [Answer, StopActivity]);
        assert_eq!(routed(WorkspaceRoute::CurrentWithLiveWork), [Snapshot]);
        assert_eq!(
            routed(WorkspaceRoute::Current),
            [
                DeleteTrigger,
                Describe,
                DispatchAgent,
                DispatchWorkflow,
                Launch,
                ListRuns,
                Roll,
                SetTriggerEnabled,
                Tasks
            ]
        );
    }

    #[test]
    fn method_names_become_non_empty_wire_names() {
        assert_eq!(NonEmptyString::from(DaemonMethod::Hello).as_str(), "hello");
        assert_eq!(
            NonEmptyString::from(WorkspaceMethod::CancelRun).as_str(),
            "workspace.cancelRun"
        );
        assert_eq!(
            NonEmptyString::from(GenerationMethod::LiveWork).as_str(),
            "liveWork"
        );
    }

    #[test]
    fn dispatching_methods_match_the_daemon() {
        use WorkspaceMethod::*;

        assert_eq!(
            workspace_methods_where(WorkspaceMethod::dispatches_work),
            [DispatchAgent, DispatchWorkflow, Launch, Resume, Roll]
        );
    }

    #[test]
    fn resume_is_both_owner_routed_and_dispatching() {
        assert_eq!(WorkspaceMethod::Resume.route(), WorkspaceRoute::Owner);
        assert!(WorkspaceMethod::Resume.dispatches_work());
    }
}
