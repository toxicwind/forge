//! estate-scripts Dots-3-Note Coercion Layer (`custom/dots`).
//!
//! Neutralizes: Ghost outputs, list:string mismatches, 22s latency, and replay crashes
//! for `dots-studio/dots-3-note-preview:free` (and alias `custom/dots`).

use serde_json::{json, Value};

pub const DOTS_CANONICAL_MODEL: &str = "dots-studio/dots-3-note-preview:free";
pub const DOTS_CUSTOM_ROUTE_MODEL: &str = "custom/dots";

/// True when the requested model or route targets the Dots-3-Note coercion layer.
pub fn is_dots_model_or_path(model: &str, path: &str) -> bool {
    path == "/v1/custom/dots"
        || model == DOTS_CUSTOM_ROUTE_MODEL
        || model == DOTS_CANONICAL_MODEL
        || model == "openrouter/dots-studio/dots-3-note-preview:free"
}

/// Apply the estate-scriptsDotsClient coercion rules to a parsed JSON chat completion body.
pub fn coerce_dots_payload(mut body: Value, session_id: &str) -> Value {
    let Some(obj) = body.as_object_mut() else {
        return body;
    };

    // Always rewrite custom/dots alias to canonical upstream model ID
    obj.insert("model".to_string(), json!(DOTS_CANONICAL_MODEL));

    // 1. Normalize prior messages: replace assistant content=null with content=""
    if let Some( msgs) = obj.get_mut("messages").and_then(|v| v.as_array_mut()) {
        for m in msgs.iter_mut() {
            if let Some(m_obj) = m.as_object_mut() {
                let is_assistant = m_obj.get("role").and_then(|r| r.as_str()) == Some("assistant");
                let is_null = m_obj.get("content").map_or(true, |c| c.is_null());
                if is_assistant && is_null {
                    m_obj.insert("content".to_string(), json!(""));
                }
            }
        }
    }

    // 2. Inject strict mode into all tool schemas
    let mut has_tools = false;
    if let Some(tools) = obj.get_mut("tools").and_then(|v| v.as_array_mut()) {
        has_tools = !tools.is_empty();
        for t in tools.iter_mut() {
            if let Some(fn_obj) = t.get_mut("function").and_then(|f| f.as_object_mut()) {
                fn_obj.insert("strict".to_string(), json!(true));
                if let Some(params) = fn_obj.get_mut("parameters").and_then(|p| p.as_object_mut()) {
                    params.insert("additionalProperties".to_string(), json!(false));
                }
            }
        }
    }

    // 3. Construct estate-scripts payload fields
    if !obj.contains_key("sessionId") {
        obj.insert("sessionId".to_string(), json!(session_id));
    }
    if !obj.contains_key("max_tokens") {
        obj.insert("max_tokens".to_string(), json!(4096));
    }
    if !obj.contains_key("temperature") {
        obj.insert("temperature".to_string(), json!(0.1));
    }
    if !obj.contains_key("reasoning") {
        obj.insert(
            "reasoning".to_string(),
            json!({
                "max_tokens": 128,
                "exclude": true
            }),
        );
    }
    let require_params = obj
        .get("provider")
        .and_then(|p| p.get("require_parameters"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    if !obj.contains_key("provider") {
        obj.insert(
            "provider".to_string(),
            json!({
                "require_parameters": require_params,
                "allow_fallbacks": false
            }),
        );
    }
    // OpenRouter returns 404 "no endpoints found" when custom stop sequences
    // and provider.require_parameters=true are sent together.
    if !require_params && !obj.contains_key("stop") {
        obj.insert(
            "stop".to_string(),
            json!(["</tool_call>", "</dots_function_call>", "<|endoftext|>", "```"]),
        );
    }

    if let Some(forced) = obj.remove("forced_tool").and_then(|v| v.as_str().map(str::to_owned)) {
        if !forced.is_empty() {
            obj.insert(
                "tool_choice".to_string(),
                json!({ "type": "function", "function": { "name": forced } }),
            );
        }
    } else if has_tools && !obj.contains_key("tool_choice") {
        obj.insert("tool_choice".to_string(), json!("auto"));
    }

    body
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coerces_null_assistant_content_and_strict_tools() {
        let raw = json!({
            "model": "custom/dots",
            "messages": [
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": null }
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "ffs_grep",
                        "parameters": { "type": "object", "properties": {} }
                    }
                }
            ],
            "forced_tool": "ffs_grep"
        });
        let out = coerce_dots_payload(raw, "sess-42");
        assert_eq!(out["model"], json!(DOTS_CANONICAL_MODEL));
        assert_eq!(out["messages"][1]["content"], json!(""));
        assert_eq!(out["tools"][0]["function"]["strict"], json!(true));
        assert_eq!(out["tools"][0]["function"]["parameters"]["additionalProperties"], json!(false));
        assert_eq!(out["reasoning"], json!({"max_tokens": 128, "exclude": true}));
        assert_eq!(out["provider"], json!({"require_parameters": true, "allow_fallbacks": false}));
        assert_eq!(out["tool_choice"], json!({"type": "function", "function": {"name": "ffs_grep"}}));
    }
}
