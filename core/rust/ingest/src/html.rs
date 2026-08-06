//! Minimal HTML cleanup for GPX description fields
//!
//! Curated route exports (GPS Visualizer, Garmin) embed HTML in `<desc>`
//! CDATA — mostly `<br />` line breaks and the odd anchor tag. We store
//! plain text with newlines preserved; this is not a general HTML parser.

/// Strip HTML tags from a description, converting `<br>` variants to
/// newlines and decoding the handful of entities that appear in practice.
/// Whitespace is trimmed per line and blank runs are collapsed.
pub fn strip_html(input: &str) -> String {
    let mut text = String::with_capacity(input.len());
    let mut chars = input.char_indices().peekable();

    while let Some((i, c)) = chars.next() {
        if c == '<' {
            let rest = &input[i..];
            let Some(end) = rest.find('>') else {
                text.push(c);
                continue;
            };
            let tag = rest[1..end].trim().to_ascii_lowercase();
            if tag == "br" || tag == "br/" || tag.starts_with("br ") || tag == "p" || tag == "/p" {
                text.push('\n');
            }
            // Skip to the closing '>'
            while let Some(&(j, _)) = chars.peek() {
                if j > i + end {
                    break;
                }
                chars.next();
            }
        } else {
            text.push(c);
        }
    }

    // &amp; decodes last so "&amp;lt;" yields "&lt;", not "<"
    let decoded = text
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&");

    // Trim each line, collapse runs of blank lines, trim the whole
    let mut out = String::with_capacity(decoded.len());
    let mut blank_pending = false;
    for line in decoded.lines() {
        let line = line.trim();
        if line.is_empty() {
            blank_pending = !out.is_empty();
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
            if blank_pending {
                out.push('\n');
            }
        }
        blank_pending = false;
        out.push_str(line);
    }
    out
}

/// Apply `strip_html` only when the text actually contains markup or
/// entities, otherwise return the input untouched (avoids reallocating for
/// the common plain-text case).
pub fn clean_description(input: &str) -> String {
    if input.contains('<') || input.contains('&') {
        strip_html(input)
    } else {
        input.trim().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_br_variants_to_newlines() {
        assert_eq!(strip_html("line one<br />line two"), "line one\nline two");
        assert_eq!(strip_html("a<br>b<BR/>c"), "a\nb\nc");
    }

    #[test]
    fn drops_other_tags_keeps_text() {
        assert_eq!(
            strip_html("Beds On the Barwon<br /><a href=\"tel:x\">+61428247024</a>"),
            "Beds On the Barwon\n+61428247024"
        );
    }

    #[test]
    fn collapses_blank_runs() {
        // GPS Visualizer's " <br /> <br />" pattern = one blank line, not three
        assert_eq!(
            strip_html("para one <br /> <br />para two"),
            "para one\n\npara two"
        );
    }

    #[test]
    fn decodes_common_entities() {
        assert_eq!(strip_html("Parks &amp; Wildlife"), "Parks & Wildlife");
        assert_eq!(strip_html("it&#39;s open"), "it's open");
    }

    #[test]
    fn plain_text_passes_through() {
        assert_eq!(
            clean_description("Rocky river crossing at Platypus flat end."),
            "Rocky river crossing at Platypus flat end."
        );
    }

    #[test]
    fn handles_unclosed_angle_bracket() {
        assert_eq!(strip_html("depth < 1m at the ford"), "depth < 1m at the ford");
    }
}
