use std::str::Utf8Error;

use thiserror::Error;

use super::MAX_LINE_BYTES;

const NEWLINE: u8 = b'\n';

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverflowPolicy {
    Fail,
    Truncate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
#[error("the peer sent a line over {limit} bytes")]
pub struct LineTooLong {
    pub limit: usize,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct PushedLines {
    pub lines: Vec<Result<String, Utf8Error>>,
    pub overflow: Option<LineTooLong>,
}

#[derive(Debug)]
pub struct LineSplitter {
    pending: Vec<u8>,
    max_line_bytes: usize,
    policy: OverflowPolicy,
    discarding_line: bool,
    failed: bool,
}

impl LineSplitter {
    pub fn new(policy: OverflowPolicy) -> Self {
        Self::with_max_line_bytes(policy, MAX_LINE_BYTES)
    }

    pub fn with_max_line_bytes(policy: OverflowPolicy, max_line_bytes: usize) -> Self {
        Self {
            pending: Vec::new(),
            max_line_bytes,
            policy,
            discarding_line: false,
            failed: false,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> PushedLines {
        let mut pushed = PushedLines::default();
        if self.failed {
            pushed.overflow = Some(self.too_long());
            return pushed;
        }
        let mut pieces = chunk.split(|byte| *byte == NEWLINE).peekable();
        while let Some(piece) = pieces.next() {
            self.append(piece, &mut pushed);
            if self.failed {
                break;
            }
            let line_is_complete = pieces.peek().is_some();
            if line_is_complete {
                self.end_line(&mut pushed);
            }
        }
        pushed
    }

    fn append(&mut self, piece: &[u8], pushed: &mut PushedLines) {
        if self.discarding_line {
            return;
        }
        let room = self.max_line_bytes.saturating_sub(self.pending.len());
        if piece.len() <= room {
            self.pending.extend_from_slice(piece);
            return;
        }
        match self.policy {
            OverflowPolicy::Fail => {
                self.failed = true;
                self.pending = Vec::new();
                pushed.overflow = Some(self.too_long());
            }
            OverflowPolicy::Truncate => {
                self.pending.extend_from_slice(&piece[..room]);
                self.discarding_line = true;
                pushed.lines.push(self.truncated());
            }
        }
    }

    fn end_line(&mut self, pushed: &mut PushedLines) {
        let bytes = std::mem::take(&mut self.pending);
        if std::mem::take(&mut self.discarding_line) {
            return;
        }
        match std::str::from_utf8(&bytes) {
            Ok(text) => pushed.lines.extend(non_blank(text).map(Ok)),
            Err(error) => pushed.lines.push(Err(error)),
        }
    }

    fn truncated(&mut self) -> Result<String, Utf8Error> {
        let bytes = std::mem::take(&mut self.pending);
        let text = match std::str::from_utf8(&bytes) {
            Ok(text) => text,
            Err(error) if error.error_len().is_none() => {
                std::str::from_utf8(&bytes[..error.valid_up_to()])?
            }
            Err(error) => return Err(error),
        };
        let marker = format!("[line truncated at {} bytes]", self.max_line_bytes);
        Ok(match text.trim() {
            "" => marker,
            head => format!("{head} {marker}"),
        })
    }

    fn too_long(&self) -> LineTooLong {
        LineTooLong {
            limit: self.max_line_bytes,
        }
    }
}

fn non_blank(text: &str) -> Option<String> {
    let line = text.trim();
    (!line.is_empty()).then(|| line.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rpc() -> LineSplitter {
        LineSplitter::new(OverflowPolicy::Fail)
    }

    fn lines(pushed: PushedLines) -> Vec<String> {
        assert_eq!(pushed.overflow, None);
        pushed
            .lines
            .into_iter()
            .map(|result| result.expect("every line should frame"))
            .collect()
    }

    #[test]
    fn single_chunk_yields_its_line() {
        assert_eq!(lines(rpc().push(b"{\"id\":1}\n")), ["{\"id\":1}"]);
    }

    #[test]
    fn fragmented_chunks_join_into_one_line() {
        let mut splitter = rpc();

        assert_eq!(splitter.push(b"{\"id\""), PushedLines::default());
        assert_eq!(splitter.push(b":1"), PushedLines::default());
        assert_eq!(lines(splitter.push(b"}\n")), ["{\"id\":1}"]);
    }

    #[test]
    fn one_chunk_can_carry_many_lines_and_a_partial_tail() {
        let mut splitter = rpc();

        assert_eq!(lines(splitter.push(b"a\nb\nc")), ["a", "b"]);
        assert_eq!(lines(splitter.push(b"\n")), ["c"]);
    }

    #[test]
    fn blank_lines_are_skipped_and_lines_are_trimmed() {
        assert_eq!(lines(rpc().push(b"\n  \n\t a \r\n\n")), ["a"]);
    }

    #[test]
    fn multi_byte_character_split_across_chunks_is_reassembled() {
        let mut splitter = rpc();
        let snowman = "☃".as_bytes();

        assert_eq!(splitter.push(&snowman[..1]), PushedLines::default());
        assert_eq!(splitter.push(&snowman[1..]), PushedLines::default());
        assert_eq!(lines(splitter.push(b"\n")), ["☃"]);
    }

    #[test]
    fn invalid_utf8_fails_only_its_own_line() {
        let pushed = rpc().push(b"\xff\nok\n");

        assert!(pushed.lines[0].is_err());
        assert_eq!(pushed.lines[1], Ok("ok".to_owned()));
        assert_eq!(pushed.overflow, None);
    }

    #[test]
    fn default_limit_is_the_protocol_maximum() {
        let mut splitter = rpc();
        let longest = vec![b'a'; MAX_LINE_BYTES];

        assert_eq!(splitter.push(&longest), PushedLines::default());
        assert_eq!(
            splitter.push(b"a").overflow,
            Some(LineTooLong {
                limit: MAX_LINE_BYTES
            })
        );
    }

    #[test]
    fn line_of_exactly_the_limit_is_accepted() {
        let mut splitter = LineSplitter::with_max_line_bytes(OverflowPolicy::Fail, 4);

        assert_eq!(lines(splitter.push(b"abcd\n")), ["abcd"]);
    }

    #[test]
    fn line_over_the_limit_fails_after_delivering_earlier_lines() {
        let mut splitter = LineSplitter::with_max_line_bytes(OverflowPolicy::Fail, 4);

        assert_eq!(
            splitter.push(b"ok\nabcde\nlater\n"),
            PushedLines {
                lines: vec![Ok("ok".to_owned())],
                overflow: Some(LineTooLong { limit: 4 }),
            }
        );
    }

    #[test]
    fn unterminated_tail_over_the_limit_fails() {
        let mut splitter = LineSplitter::with_max_line_bytes(OverflowPolicy::Fail, 4);

        assert_eq!(splitter.push(b"abc"), PushedLines::default());
        assert_eq!(
            splitter.push(b"de").overflow,
            Some(LineTooLong { limit: 4 })
        );
    }

    #[test]
    fn a_failed_splitter_stays_failed() {
        let mut splitter = LineSplitter::with_max_line_bytes(OverflowPolicy::Fail, 4);
        splitter.push(b"abcde");

        assert_eq!(
            splitter.push(b"ok\n"),
            PushedLines {
                lines: Vec::new(),
                overflow: Some(LineTooLong { limit: 4 }),
            }
        );
    }

    #[test]
    fn truncation_marks_the_line_and_carries_on() {
        let mut splitter = LineSplitter::with_max_line_bytes(OverflowPolicy::Truncate, 4);

        assert_eq!(
            lines(splitter.push(b"ok\nabcdef\nnext\n")),
            ["ok", "abcd [line truncated at 4 bytes]", "next"]
        );
    }

    #[test]
    fn a_cut_line_stays_cut_across_chunks_until_its_newline() {
        let mut splitter = LineSplitter::with_max_line_bytes(OverflowPolicy::Truncate, 4);

        assert_eq!(splitter.push(b"abc"), PushedLines::default());
        assert_eq!(
            lines(splitter.push(b"def")),
            ["abcd [line truncated at 4 bytes]"]
        );
        assert_eq!(splitter.push(b"ghi"), PushedLines::default());
        assert_eq!(lines(splitter.push(b"jkl\nnext\n")), ["next"]);
    }

    #[test]
    fn a_cut_inside_a_character_drops_the_partial_character() {
        let mut splitter = LineSplitter::with_max_line_bytes(OverflowPolicy::Truncate, 4);

        assert_eq!(
            lines(splitter.push("ab☃cd\n".as_bytes())),
            ["ab [line truncated at 4 bytes]"]
        );
    }

    #[test]
    fn truncation_leaves_a_line_of_exactly_the_limit_whole() {
        let mut splitter = LineSplitter::with_max_line_bytes(OverflowPolicy::Truncate, 4);

        assert_eq!(lines(splitter.push(b"abcd\nabcd")), ["abcd"]);
        assert_eq!(lines(splitter.push(b"\n")), ["abcd"]);
    }
}
