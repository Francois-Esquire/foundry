# Long-lived piped processes in a sandbox

Maintainer note, excluded from the Blume site. Dated 2026-10-03.

## What we need

Some programs in a sandbox are driven by a host process over their standard
streams: an agent CLI exchanging JSON over stdin and stdout, a language
server, a REPL. They need:

- a process that keeps running across many messages;
- stdin as a writable byte stream;
- stdout and stderr as separate, unmodified readable byte streams;
- the exit code or signal, errors, and a way to kill it;
- shutdown when the run stops.

A terminal is the wrong tool. It merges stdout and stderr, echoes input, and
can rewrite line endings, and any of those corrupts a protocol.

Done means a host process can drive a program in a sandbox exactly as it
would a local child process.

## Opinion: how to build it

- Add a piped spawn to the container runtime: microsandbox's streaming exec
  with no TTY and a piped stdin. The runtime already uses that streaming
  exec for the interactive shell (with a TTY) and for background processes
  (with no stdin), so this is the missing combination.
- Expose it on the processes facet with a handle shaped like a Node child
  process: `stdin` writable, `stdout` and `stderr` readable, `exitCode`,
  `killed`, `kill(signal)`, and `exit` and `error` events. Anything that
  accepts a child process can then use it, including the Claude Agent SDK's
  custom spawn.
- Keep bytes as bytes. Don't decode to strings in the runtime.
- Tie the process's lifetime to the run's abort signal, as other sandbox
  commands are.
