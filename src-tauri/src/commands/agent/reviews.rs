//! Local review patches are never inserted into provider history eagerly.
use super::failure;
use crate::error::AppResult;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewChange {
    id: String,
    old_text: String,
    new_text: String,
    #[serde(default)]
    reason: String,
}

pub fn validate(changes: &[ReviewChange]) -> AppResult<()> {
    let mut ids = HashSet::new();
    if changes.len() > 384
        || changes.iter().any(|change| {
            change.id.is_empty()
                || change.id.len() > 160
                || change.id.chars().any(char::is_control)
                || !ids.insert(&change.id)
                || change.old_text.len() > 2_000_000
                || change.new_text.len() > 240_000
                || change.reason.len() > 4_000
        })
        || changes
            .iter()
            .map(|change| change.old_text.len() + change.new_text.len() + change.reason.len())
            .sum::<usize>()
            > 16_000_000
    {
        return Err(failure("invalidRequest"));
    }
    Ok(())
}

pub fn execute(changes: &[ReviewChange], arguments: &str) -> Value {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Args {
        id: String,
        field: String,
        #[serde(default)]
        start_char: usize,
        #[serde(default = "default_limit")]
        max_chars: usize,
    }
    fn default_limit() -> usize {
        2_000
    }
    let Ok(args) = serde_json::from_str::<Args>(arguments) else {
        return json!({"error":"Supply id, field (oldText/newText/reason), optional startChar and maxChars."});
    };
    let Some(change) = changes.iter().find(|change| change.id == args.id) else {
        return json!({"error":"Unknown or unavailable review change ID. Ask the user to attach the relevant text."});
    };
    let text = match args.field.as_str() {
        "oldText" => &change.old_text,
        "newText" => &change.new_text,
        "reason" => &change.reason,
        _ => return json!({"error":"field must be oldText, newText or reason."}),
    };
    let total = text.chars().count();
    if args.max_chars == 0 || args.max_chars > 4_000 || args.start_char > total {
        return json!({"error":"Use an existing startChar and maxChars from 1 to 4000. Offsets count Unicode characters."});
    }
    let excerpt = text
        .chars()
        .skip(args.start_char)
        .take(args.max_chars)
        .collect::<String>();
    let end = args.start_char + excerpt.chars().count();
    json!({"id":change.id,"field":args.field,"startChar":args.start_char,"endChar":end,"totalChars":total,"text":excerpt,"hasMore":end < total})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn review_reads_are_exact_bounded_and_cannot_access_other_local_data() {
        let changes: Vec<ReviewChange> = serde_json::from_value(json!([{"id":"a:1","oldText":"original","newText":"😀中文\nreplacement","reason":"keep my voice"}])).unwrap();
        validate(&changes).unwrap();
        let result = execute(
            &changes,
            r#"{"id":"a:1","field":"newText","startChar":1,"maxChars":3}"#,
        );
        assert_eq!(result["text"], "中文\n");
        assert_eq!(result["endChar"], 4);
        assert_eq!(result["hasMore"], true);
        assert_eq!(
            execute(&changes, r#"{"id":"a:1","field":"reason"}"#)["text"],
            "keep my voice"
        );
        for args in [
            r#"{"id":"missing","field":"oldText"}"#,
            r#"{"id":"a:1","field":"path"}"#,
            r#"{"id":"a:1","field":"oldText","maxChars":4001}"#,
            r#"{"id":"a:1","field":"oldText","startChar":100}"#,
            r#"{"id":"a:1","field":"oldText","path":"secret"}"#,
        ] {
            assert!(execute(&changes, args).get("error").is_some());
        }
        let duplicate: Vec<ReviewChange> = serde_json::from_value(
            json!([{"id":"a","oldText":"a","newText":"b"},{"id":"a","oldText":"c","newText":"d"}]),
        )
        .unwrap();
        assert!(validate(&duplicate).is_err());
    }
}
