const NEWLINE: u8 = b'\n';
const REPLACEMENT: char = '\u{FFFD}';

#[derive(Debug)]
pub(super) struct OutputLines {
    line: Vec<u8>,
    cut: bool,
    limit: usize,
}

impl OutputLines {
    pub(super) fn new(limit: usize) -> Self {
        Self {
            line: Vec::new(),
            cut: false,
            limit,
        }
    }

    pub(super) fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        let mut lines = Vec::new();
        let mut pieces = chunk.split(|byte| *byte == NEWLINE).peekable();
        while let Some(piece) = pieces.next() {
            self.take(piece, &mut lines);
            if pieces.peek().is_some() {
                if !self.cut {
                    lines.push(decoded(&self.line));
                }
                self.line.clear();
                self.cut = false;
            }
        }
        lines
    }

    pub(super) fn finish(&mut self) -> Option<String> {
        let unterminated = !self.cut && !self.line.is_empty();
        let line = unterminated.then(|| decoded(&self.line));
        self.line.clear();
        self.cut = false;
        line
    }

    fn take(&mut self, piece: &[u8], lines: &mut Vec<String>) {
        if self.cut || piece.is_empty() {
            return;
        }
        let room = self.limit.saturating_sub(self.line.len());
        if piece.len() <= room {
            self.line.extend_from_slice(piece);
            return;
        }
        self.line.extend_from_slice(&piece[..room]);
        lines.push(format!(
            "{} [line truncated at {} bytes]",
            decoded(&self.line),
            self.limit
        ));
        self.line.clear();
        self.cut = true;
    }
}

fn decoded(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len());
    let mut chunks = bytes.utf8_chunks().peekable();
    while let Some(chunk) = chunks.next() {
        text.push_str(chunk.valid());
        let invalid = chunk.invalid();
        let partial_tail = chunks.peek().is_none()
            && std::str::from_utf8(invalid).is_err_and(|error| error.error_len().is_none());
        if !invalid.is_empty() && !partial_tail {
            text.push(REPLACEMENT);
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pushed(limit: usize, chunks: &[&[u8]]) -> Vec<String> {
        let mut lines = OutputLines::new(limit);
        chunks.iter().flat_map(|chunk| lines.push(chunk)).collect()
    }

    #[test]
    fn lines_keep_indentation_and_blank_lines() {
        assert_eq!(
            pushed(64, &[b"  indented\n\nlast\n"]),
            ["  indented", "", "last"]
        );
    }

    #[test]
    fn a_line_split_across_chunks_is_joined() {
        assert_eq!(
            pushed(64, &[b"hel", b"lo\nwor", b"ld\n"]),
            ["hello", "world"]
        );
    }

    #[test]
    fn a_character_split_across_chunks_survives() {
        assert_eq!(pushed(64, &[&[0xe2, 0x98], &[0x83, b'\n']]), ["\u{2603}"]);
    }

    #[test]
    fn invalid_bytes_become_replacement_characters() {
        assert_eq!(pushed(64, &[b"a\xffb\n"]), ["a\u{FFFD}b"]);
    }

    #[test]
    fn a_long_line_is_cut_once_and_the_rest_dropped() {
        assert_eq!(
            pushed(4, &[b"abcdef", b"gh\nok\n"]),
            ["abcd [line truncated at 4 bytes]", "ok"]
        );
    }

    #[test]
    fn a_cut_through_a_character_drops_the_partial_character() {
        assert_eq!(
            pushed(4, &["ab\u{2603}c\n".as_bytes()]),
            ["ab [line truncated at 4 bytes]"]
        );
    }

    #[test]
    fn an_unterminated_last_line_is_flushed_at_the_end() {
        let mut lines = OutputLines::new(64);

        assert!(lines.push(b"no newline").is_empty());
        assert_eq!(lines.finish().as_deref(), Some("no newline"));
        assert_eq!(lines.finish(), None);
    }
}
