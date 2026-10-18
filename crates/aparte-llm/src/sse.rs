//! An incremental parser for `text/event-stream` bodies, as the HTML standard defines them: lines end with LF,
//! CRLF or CR (Gemini sends CRLF, the others LF), `data` lines of one event are joined with LF, a blank line
//! dispatches the event, and comment lines (`:` first) are skipped. Bytes may arrive split anywhere, even inside a
//! multi-byte character or between the CR and the LF of one line ending.

/// One dispatched event.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SseEvent {
    /// The `event` field; empty when the server sent none (the standard's default type is `message`).
    pub event: String,
    /// The `data` lines, joined with LF.
    pub data: String,
    /// The last `id` field seen, if any.
    pub id: Option<String>,
}

/// Feeds bytes in, takes events out.
#[derive(Debug, Default)]
pub struct SseParser {
    buf: Vec<u8>,
    /// The previous chunk ended with CR: a LF at the start of the next one belongs to the same line ending.
    skip_lf: bool,
    started: bool,
    event: String,
    data: String,
    has_data: bool,
    id: Option<String>,
}

impl SseParser {
    /// A parser at the start of a stream.
    pub fn new() -> SseParser {
        SseParser::default()
    }

    /// Adds bytes and returns the events they complete, in order.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<SseEvent> {
        let mut out = Vec::new();
        let mut input = bytes;
        if self.skip_lf && !input.is_empty() {
            self.skip_lf = false;
            if input[0] == b'\n' {
                input = &input[1..];
            }
        }
        self.buf.extend_from_slice(input);
        let mut start = 0;
        let mut i = 0;
        let buf = std::mem::take(&mut self.buf);
        while i < buf.len() {
            match buf[i] {
                b'\n' => {
                    self.line(&buf[start..i], &mut out);
                    i += 1;
                    start = i;
                }
                b'\r' => {
                    self.line(&buf[start..i], &mut out);
                    i += 1;
                    if i < buf.len() {
                        if buf[i] == b'\n' {
                            i += 1;
                        }
                    } else {
                        self.skip_lf = true;
                    }
                    start = i;
                }
                _ => i += 1,
            }
        }
        self.buf = buf[start..].to_vec();
        out
    }

    /// Ends the stream. An event without its closing blank line is dropped, as the standard requires.
    pub fn finish(&mut self) -> Vec<SseEvent> {
        let mut out = Vec::new();
        if !self.buf.is_empty() {
            let rest = std::mem::take(&mut self.buf);
            self.line(&rest, &mut out);
        }
        out
    }

    fn line(&mut self, raw: &[u8], out: &mut Vec<SseEvent>) {
        let mut line = String::from_utf8_lossy(raw).into_owned();
        if !self.started {
            self.started = true;
            if let Some(rest) = line.strip_prefix('\u{feff}') {
                line = rest.to_owned();
            }
        }
        if line.is_empty() {
            if self.has_data {
                out.push(SseEvent {
                    event: std::mem::take(&mut self.event),
                    data: std::mem::take(&mut self.data),
                    id: self.id.clone(),
                });
            } else {
                self.event.clear();
            }
            self.has_data = false;
            return;
        }
        if line.starts_with(':') {
            return;
        }
        let (field, value) = match line.find(':') {
            Some(at) => {
                let v = &line[at + 1..];
                (&line[..at], v.strip_prefix(' ').unwrap_or(v))
            }
            None => (line.as_str(), ""),
        };
        match field {
            "event" => self.event = value.to_owned(),
            "data" => {
                if self.has_data {
                    self.data.push('\n');
                }
                self.data.push_str(value);
                self.has_data = true;
            }
            "id" if !value.contains('\0') => self.id = Some(value.to_owned()),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{SseEvent, SseParser};
    use proptest::prelude::*;

    fn all(chunks: &[&[u8]]) -> Vec<SseEvent> {
        let mut p = SseParser::new();
        let mut out = Vec::new();
        for c in chunks {
            out.extend(p.feed(c));
        }
        out.extend(p.finish());
        out
    }

    #[test]
    fn parses_named_events_and_joins_data_lines() {
        let ev = all(&[b"event: a\ndata: 1\ndata: 2\n\n: comment\ndata:x\n\n"]);
        assert_eq!(ev.len(), 2);
        assert_eq!(ev[0].event, "a");
        assert_eq!(ev[0].data, "1\n2");
        assert_eq!(ev[1].event, "");
        assert_eq!(ev[1].data, "x");
    }

    #[test]
    fn accepts_crlf_and_cr_split_across_chunks() {
        let ev = all(&[b"data: a\r", b"\n\r", b"\ndata: b\r\r"]);
        assert_eq!(ev.iter().map(|e| e.data.as_str()).collect::<Vec<_>>(), ["a", "b"]);
    }

    #[test]
    fn an_unterminated_event_is_dropped() {
        assert!(all(&[b"data: never dispatched"]).is_empty());
    }

    proptest! {
        #[test]
        fn chunking_never_changes_the_events(
            body in "(event: [a-z]{1,5}\r?\n)?(data: [a-zé ]{0,8}\r?\n){1,3}\r?\n",
            reps in 1usize..4,
            cuts in proptest::collection::vec(0usize..200, 0..8),
        ) {
            let text = body.repeat(reps);
            let bytes = text.as_bytes();
            let whole = all(&[bytes]);
            let mut points: Vec<usize> = cuts.into_iter().map(|c| c % (bytes.len() + 1)).collect();
            points.sort_unstable();
            let mut chunks: Vec<&[u8]> = Vec::new();
            let mut last = 0;
            for p in points {
                chunks.push(&bytes[last..p]);
                last = p;
            }
            chunks.push(&bytes[last..]);
            prop_assert_eq!(all(&chunks), whole);
        }
    }
}
