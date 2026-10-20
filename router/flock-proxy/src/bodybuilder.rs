//! bodybuilder — Rust port of the estate-scripts router's bodybuilder workflow.
//!
//! Source: `estate-scripts-router-ts/router_strategy.ts`
//! (`buildBodybuilderRequests` + `runBodybuilderAutonomous`), the estate-owned
//! openrouter/bodybuilder equivalent: a natural-language multi-model job is
//! decomposed into parallel LLM request bodies (`{requests:[...]}`) and,
//! in autonomous mode, each body is executed through the router so the caller
//! only ever sends the original prompt and gets answers back.
//!
//! Decomposition and execution are fully native: the decomposer LLM call
//! runs through flock's own `router.execute_buffered` (the `auto` strategy
//! over the live provider pool), and autonomous fan-out executes each body
//! through the same internal dispatch in parallel. No upstream, no second
//! proxy. Request chunking, deterministic fallbacks, response sanitizing,
//! and the `/v1/bodybuilder` HTTP handler are all native Rust here.

use std::sync::Arc;

use axum::{
	Json,
	extract::State,
	http::{HeaderMap, StatusCode, header},
	response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::AppState;

// ---------------------------------------------------------------------------
// Constants (mirror the TS ports)
// ---------------------------------------------------------------------------

/// A job larger than the decomposer's own safe context (~200k est tokens for
/// the free pool) would be truncated or refused by the decomposer LLM, so it
/// is chunked deterministically instead — one context-fitted request per chunk.
const DECOMPOSER_BUDGET_TOKENS: usize = 200_000;
/// Lower bound for a chunk when fitting a large job into `max_requests` chunks.
const CHUNK_MIN_CHARS: usize = 800_000;
/// Decomposition call deadline (non-streaming buffered upstream read).
const DECOMPOSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);
/// Autonomous end-to-end deadline (build + parallel execution).
const AUTONOMOUS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);
/// TS default when `maxRequests` is not supplied.
const DEFAULT_MAX_REQUESTS: usize = 4;
/// TS clamps `maxRequests` into [1, 16].
const MAX_MAX_REQUESTS: usize = 16;

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/// Bodybuilder failure: decomposition or execution failed.
#[derive(Debug)]
pub enum BodybuilderError {
	/// Internal dispatch failure (router unavailable, all providers failed).
	Dispatch(String),
	/// The upstream answered but not with a usable `{requests:[...]}` body.
	BadResponse(String),
}

impl std::fmt::Display for BodybuilderError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			BodybuilderError::Dispatch(e) => write!(f, "bodybuilder dispatch: {e}"),
			BodybuilderError::BadResponse(e) => write!(f, "bodybuilder bad response: {e}"),
		}
	}
}

impl std::error::Error for BodybuilderError {}

/// Convenience alias for bodybuilder results.
pub type BbResult<T> = Result<T, BodybuilderError>;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// Free-tier `provider/model` IDs from the live config, for the decomposer
/// allow-list. Mirrors TS `freeCandidates()`.
pub fn free_pool_ids(providers: &[crate::providers::ProviderDef]) -> Vec<String> {
	let mut ids = Vec::new();
	for p in providers {
		if !p.enabled || !p.free_tier {
			continue;
		}
		for m in &p.models {
			ids.push(format!("{}/{}", p.name, m));
		}
	}
	ids
}

/// Mirror of the TS clamp: `Math.min(Math.max(opts.maxRequests ?? 4, 1), 16)`.
pub fn normalize_max_requests(max_requests: Option<usize>) -> usize {
	match max_requests {
		None => DEFAULT_MAX_REQUESTS,
		Some(n) => n.clamp(1, MAX_MAX_REQUESTS),
	}
}

// ---------------------------------------------------------------------------
// Pure ports: chunkJobText, sanitizeBodybuilderRequests
// ---------------------------------------------------------------------------

/// Port of `chunkJobText`: paragraph-aware split of `job` into chunks of at
/// most `max_chars` bytes, splitting on runs of 2+ newlines first, then
/// hard-splitting pathological single paragraphs. A job that already fits is
/// returned as one chunk.
pub fn chunk_job_text(job: &str, max_chars: usize) -> Vec<String> {
	if job.len() <= max_chars {
		return vec![job.to_string()];
	}
	// Paragraphs, split on runs of >= 2 newlines (byte scan; cut points are
	// always on newline bytes, so they are valid char boundaries).
	let bytes = job.as_bytes();
	let mut paras: Vec<&str> = Vec::new();
	let mut start = 0usize;
	let mut i = 0usize;
	while i < bytes.len() {
		if bytes[i] == b'\n' {
			let mut j = i;
			while j < bytes.len() && bytes[j] == b'\n' {
				j += 1;
			}
			if j - i >= 2 {
				paras.push(&job[start..i]);
				start = j;
			}
			i = j;
		} else {
			i += 1;
		}
	}
	paras.push(&job[start..]);

	let mut chunks: Vec<String> = Vec::new();
	let mut cur = String::new();
	for para in paras {
		let cand = if cur.is_empty() {
			para.len()
		} else {
			cur.len() + 2 + para.len()
		};
		if cand > max_chars && !cur.is_empty() {
			chunks.push(std::mem::take(&mut cur));
			cur.push_str(para);
		} else if cur.is_empty() {
			cur.push_str(para);
		} else {
			cur.push_str("\n\n");
			cur.push_str(para);
		}
	}
	if !cur.is_empty() {
		chunks.push(cur);
	}
	// A single pathological paragraph longer than the budget: hard-split it.
	let mut out: Vec<String> = Vec::new();
	for c in chunks {
		if c.len() <= max_chars {
			out.push(c);
		} else {
			let mut s = 0usize;
			while s < c.len() {
				let mut e = (s + max_chars).min(c.len());
				while e > s && !c.is_char_boundary(e) {
					e -= 1;
				}
				if e == s {
					e = c.len(); // unreachable (chars are <= 4 bytes)
				}
				out.push(c[s..e].to_string());
				s = e;
			}
		}
	}
	out
}

/// Pairwise merge until `chunks` fits in `max_requests` (TS halves the list
/// repeatedly; content is never dropped).
fn merge_chunks_to_fit(mut chunks: Vec<String>, max_requests: usize) -> Vec<String> {
	while chunks.len() > max_requests {
		let mut merged: Vec<String> = Vec::with_capacity(chunks.len().div_ceil(2));
		let mut i = 0;
		while i < chunks.len() {
			let mut m = std::mem::take(&mut chunks[i]);
			if i + 1 < chunks.len() {
				m.push_str("\n\n");
				m.push_str(&chunks[i + 1]);
			}
			merged.push(m);
			i += 2;
		}
		chunks = merged;
	}
	chunks
}

/// Deterministic router-max chunk path: the whole job is chunked so it fits
/// in `max_requests` chunks (content never dropped), and each chunk becomes a
/// self-contained `PART i/N` request body routed via the `auto` strategy.
pub fn chunked_request_bodies(job: &str, max_requests: usize) -> Vec<Value> {
	let chunk_chars = CHUNK_MIN_CHARS.max(job.len().div_ceil(max_requests));
	let chunks = merge_chunks_to_fit(chunk_job_text(job, chunk_chars), max_requests);
	let n = chunks.len().max(1);
	chunks
        .into_iter()
        .enumerate()
        .map(|(i, chunk)| {
            json!({
                "model": "auto",
                "messages": [{
                    "role": "user",
                    "content": format!(
                        "PART {}/{} of a larger job. Process ONLY the segment below per the job instructions embedded in it; reply with your segment's result only.\n\nSEGMENT:\n{}",
                        i + 1,
                        n,
                        chunk
                    ),
                }],
                "temperature": 0.7,
                "max_tokens": 2000,
            })
        })
        .collect()
}

/// Port of `sanitizeBodybuilderRequests`: rewrite decomposer-emitted bodies
/// into routable, safe ones — slice to `max_requests`, enforce the model
/// allow-list (round-robin fallback when a decomposer hallucinates an id),
/// and clamp sampling params (`temperature` [0,2], `max_tokens` [1,32000])
/// so a rogue decomposer cannot burn the pool or 400 downstream.
///
/// `allow_ids` is the live free-pool `provider/model` list. It is `None` in
/// flock today because the live free-pool catalog still belongs to the
/// estate-scripts router (Worker D's routing-intelligence port); with `None` the
/// model field passes through untouched and only the sampling clamps apply.
/// NOTE (Worker D): `resolveSigmaAlias` (TS sigma-catalog alias resolution)
/// has no Rust equivalent yet — wire it here when the catalog lands.
pub fn sanitize_requests(
	reqs: Vec<Value>,
	allow_ids: Option<&[String]>,
	max_requests: usize,
) -> Vec<Value> {
	let allow: Option<std::collections::HashSet<&str>> =
		allow_ids.map(|ids| ids.iter().map(|s| s.as_str()).collect());
	reqs
		.into_iter()
		.take(max_requests)
		.enumerate()
		.map(|(i, v)| {
			let mut rec: Map<String, Value> = match v {
				Value::Object(m) => m,
				other => {
					let mut m = Map::new();
					m.insert("raw".to_string(), other);
					m
				},
			};
			if let Some(set) = &allow {
				let mid = rec
					.get("model")
					.and_then(|m| m.as_str())
					.unwrap_or("")
					.to_string();
				if !set.contains(mid.as_str()) {
					if let Some(ids) = allow_ids {
						if !ids.is_empty() {
							rec.insert("model".to_string(), Value::String(ids[i % ids.len()].clone()));
						}
					}
				}
			}
			if let Some(t) = rec.get("temperature").and_then(|t| t.as_f64()) {
				if t.is_finite() {
					rec.insert("temperature".to_string(), json!(t.clamp(0.0, 2.0)));
				}
			}
			if let Some(mt) = rec.get("max_tokens").and_then(|m| m.as_f64()) {
				if mt.is_finite() {
					rec.insert("max_tokens".to_string(), json!((mt.floor() as i64).clamp(1, 32000)));
				}
			}
			Value::Object(rec)
		})
		.collect()
}


/// Native decomposition: run the decomposer LLM through flock's own
/// `router.execute_buffered` (the `auto` strategy over the live provider
/// pool). Mirrors TS `buildBodybuilderRequests` LLM path: system prompt with
/// the live free-pool allow-list, `temperature: 0.3`, parse
/// `choices[0].message.content` as JSON, strip fences, sanitize.
async fn decompose_native(
    job: &str,
    max_requests: usize,
    state: &Arc<AppState>,
    allow_ids: &[String],
    sid: &str,
) -> BbResult<Vec<Value>> {
    let sys = format!(
        "You decompose a multi-model job into parallel LLM request bodies. \
         Reply with ONLY a JSON object of the form \
         '{{\"requests\":[{{\"model\":\"<provider/model id>\",\"messages\":[{{\"role\":\"user\",\"content\":\"<self-contained sub-task>\"}}],\
         \"temperature\":0.7,\"max_tokens\":2000}}]}}. \
         Each request must be self-contained (no cross-references between requests). \
         The \"model\" field MUST be one of these exact IDs, verbatim - never invent a model ID: {}. \
         Produce between 1 and {} requests. No prose, no markdown fences, JSON only.",
        allow_ids.join(", "),
        max_requests
    );
    let body = json!({
        "model": "auto",
        "messages": [
            {"role": "system", "content": sys},
            {"role": "user", "content": format!("JOB:\n{job}")},
        ],
        "temperature": 0.3,
        "max_tokens": 4000,
        "stream": false,
    });
    let body_bytes = serde_json::to_vec(&body)
        .map_err(|e| BodybuilderError::BadResponse(format!("encode decomposer body: {e}")))?;

    let ectx = crate::router::ExecuteCtx {
        http: state.http.clone(),
        method: reqwest::Method::POST,
        path_query: "/v1/chat/completions".to_string(),
        content_type: Some("application/json".to_string()),
        accept: None,
        body: bytes::Bytes::from(body_bytes),
        model: "auto".to_string(),
        passthrough: Vec::new(),
        session: Some(format!("bodybuilder:{sid}")),
        deadline: std::time::Instant::now() + DECOMPOSE_TIMEOUT,
        heartbeat: std::time::Duration::from_secs(30),
        request_timeout: DECOMPOSE_TIMEOUT,
        prefer_lane: None,
        gated_path: true,
        client_gone: Box::new(|| false),
    };

    let outcome = state
        .router
        .execute_buffered(ectx)
        .await
        .map_err(|e| BodybuilderError::Dispatch(format!("decomposer dispatch: {e:?}")))?;

    let text = match outcome {
        crate::router::ExecuteOutcome::Buffered { body, .. } => {
            String::from_utf8_lossy(&body).into_owned()
        }
        crate::router::ExecuteOutcome::Response(resp) => resp
            .text()
            .await
            .map_err(|e| BodybuilderError::Dispatch(format!("decomposer read: {e}")))?,
        crate::router::ExecuteOutcome::Coalesced(shared) => {
            String::from_utf8_lossy(&shared.body).into_owned()
        }
    };

    // TS: JSON.parse(raw)?.choices?.[0]?.message?.content, strip ``` fences.
    let outer: Value = serde_json::from_str(&text)
        .map_err(|e| BodybuilderError::BadResponse(format!("decomposer outer JSON: {e}")))?;
    let content = outer
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let mut cleaned = content.trim();
    if let Some(rest) = cleaned.strip_prefix("```") {
        let rest = rest.strip_prefix("json").unwrap_or(rest);
        cleaned = rest.trim_start();
    }
    if let Some(idx) = cleaned.rfind("```") {
        cleaned = cleaned[..idx].trim_end();
    }
    let parsed: Value = serde_json::from_str(cleaned)
        .map_err(|e| BodybuilderError::BadResponse(format!("decomposer inner JSON: {e}")))?;
    let reqs = parsed
        .get("requests")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if reqs.is_empty() {
        return Err(BodybuilderError::BadResponse(
            "decomposer returned no requests".to_string(),
        ));
    }
    Ok(sanitize_requests(reqs, Some(allow_ids), max_requests))
}

/// Extract the assistant text from a chat-completion body, mirroring TS
/// `bodybuilderResultText`.
fn result_text_from_body(body: &[u8]) -> String {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| {
            v.pointer("/choices/0/message/content")
                .and_then(|c| c.as_str())
                .map(str::to_string)
        })
        .unwrap_or_default()
}

/// Execute one decomposed body through flock's internal dispatch.
/// Mirrors TS `dispatchBodybuilderBody`: honor the pinned `provider/model`,
/// non-streaming, full race failover via the router.
async fn dispatch_body_native(
    req_body: &Value,
    state: &Arc<AppState>,
    sid: &str,
) -> (bool, String, Option<String>, Option<String>) {
    // Returns (ok, text_or_empty, error_or_none, routed_via_or_none).
    let mut body_map = req_body.as_object().cloned().unwrap_or_default();
    body_map.insert("stream".to_string(), json!(false));
    let model = body_map
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or("auto")
        .to_string();

    let body_bytes = match serde_json::to_vec(&Value::Object(body_map)) {
        Ok(b) => b,
        Err(e) => return (false, String::new(), Some(format!("encode: {e}")), None),
    };

    let ectx = crate::router::ExecuteCtx {
        http: state.http.clone(),
        method: reqwest::Method::POST,
        path_query: "/v1/chat/completions".to_string(),
        content_type: Some("application/json".to_string()),
        accept: None,
        body: bytes::Bytes::from(body_bytes),
        model: model.clone(),
        passthrough: Vec::new(),
        session: Some(format!("bodybuilder:{sid}")),
        deadline: std::time::Instant::now() + AUTONOMOUS_TIMEOUT,
        heartbeat: std::time::Duration::from_secs(30),
        request_timeout: AUTONOMOUS_TIMEOUT,
        prefer_lane: None,
        gated_path: true,
        client_gone: Box::new(|| false),
    };

    let t0 = std::time::Instant::now();
    match state.router.execute_buffered(ectx).await {
        Ok(outcome) => {
            let (status_ok, bytes) = match outcome {
                crate::router::ExecuteOutcome::Buffered { status, body, .. } => {
                    (status >= 200 && status < 300, body)
                }
                crate::router::ExecuteOutcome::Response(resp) => {
                    let s = resp.status().as_u16();
                    match resp.bytes().await {
                        Ok(b) => (s >= 200 && s < 300, b),
                        Err(e) => {
                            return (
                                false,
                                String::new(),
                                Some(format!("read: {e}")),
                                None,
                            )
                        }
                    }
                }
                crate::router::ExecuteOutcome::Coalesced(shared) => {
                    (shared.status >= 200 && shared.status < 300, shared.body.clone())
                }
            };
            if !status_ok {
                return (
                    false,
                    String::new(),
                    Some("upstream error".to_string()),
                    None,
                );
            }
            let text = result_text_from_body(&bytes);
            if text.trim().is_empty() {
                (false, String::new(), Some("empty_completion".to_string()), None)
            } else {
                let _ = t0;
                (true, text, None, Some(model))
            }
        }
        Err(e) => (
            false,
            String::new(),
            Some(format!("{e:?}")),
            None,
        ),
    }
}

/// Port of `buildBodybuilderRequests`: decompose a natural-language job into
/// parallel LLM request bodies — fully native.
///
/// Router-max first: a job larger than the decomposer's safe context is
/// chunked deterministically (one context-fitted request per chunk) rather
/// than handed to the decomposer LLM. Otherwise the decomposer LLM runs
/// through flock's own router (`auto` strategy over the live free-tier pool),
/// and its output is sanitized natively. If decomposition fails or returns
/// no requests, fall back to the deterministic fan-out.
pub async fn build_bodybuilder_requests(
    job: &str,
    max_requests: Option<usize>,
    state: &Arc<AppState>,
    sid: &str,
) -> BbResult<Vec<Value>> {
    let max_requests = normalize_max_requests(max_requests);
    // Router-max: the decomposer's own context budget.
    if job.len() / 4 > DECOMPOSER_BUDGET_TOKENS {
        return Ok(chunked_request_bodies(job, max_requests));
    }
    let allow_ids = free_pool_ids(&state.store.lock().unwrap().providers);
    if allow_ids.is_empty() {
        // No free pool: deterministic fan-out with `auto` routing.
        return Ok(deterministic_fanout(job, max_requests));
    }
    match decompose_native(job, max_requests, state, &allow_ids, sid).await {
        Ok(reqs) if !reqs.is_empty() => Ok(reqs),
        _ => Ok(deterministic_fanout(job, max_requests)),
    }
}

/// Deterministic fallback: `max_requests` parallel `auto`-routed requests.
/// Chunked when the job is large so content is never dropped; otherwise each
/// carries the full job text. Mirrors the TS fallback.
fn deterministic_fanout(job: &str, max_requests: usize) -> Vec<Value> {
    let chunk_chars = CHUNK_MIN_CHARS.max(job.len().div_ceil(max_requests));
    let chunks = merge_chunks_to_fit(chunk_job_text(job, chunk_chars), max_requests);
    if chunks.len() > 1 {
        return chunked_request_bodies(job, max_requests);
    }
    (0..max_requests)
        .map(|_| {
            json!({
                "model": "auto",
                "messages": [{ "role": "user", "content": job }],
                "temperature": 0.7,
                "max_tokens": 2000,
            })
        })
        .collect()
}

/// Port of `runBodybuilderAutonomous`: the whole bodybuilder workflow with no
/// human in the loop — build the request bodies and execute each one through
/// flock's internal dispatch in parallel, returning
/// `{requests:[...], results:[...]}` where each result carries
/// `{model, ok, text?, error?, latency_ms?, routed_via?}`.
///
/// With `execute == false` this is bodies-only (`{requests:[...]}`).
pub async fn run_bodybuilder_autonomous(
    job: &str,
    max_requests: Option<usize>,
    execute: bool,
    state: &Arc<AppState>,
) -> BbResult<Value> {
    let max_requests = normalize_max_requests(max_requests);
    let sid = format!("bb-auto-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0));
    let requests = build_bodybuilder_requests(job, Some(max_requests), state, &sid).await?;
    if !execute {
        return Ok(json!({ "requests": requests }));
    }

    // Parallel fan-out through the native dispatcher.
    let futures: Vec<_> = requests
        .iter()
        .map(|req| {
            let state = Arc::clone(state);
            let req = req.clone();
            let sid = sid.clone();
            async move {
                let want = req
                    .get("model")
                    .and_then(|m| m.as_str())
                    .unwrap_or("auto")
                    .to_string();
                let t0 = std::time::Instant::now();
                let (ok, text, error, routed_via) =
                    dispatch_body_native(&req, &state, &sid).await;
                let ms = t0.elapsed().as_millis() as u64;
                let mut out = json!({
                    "model": want,
                    "ok": ok,
                    "latency_ms": ms,
                });
                if ok {
                    out["text"] = json!(text);
                }
                if let Some(e) = error {
                    out["error"] = json!(e);
                }
                if let Some(r) = routed_via {
                    out["routed_via"] = json!(r);
                }
                out
            }
        })
        .collect();
    let results: Vec<Value> = futures_util::future::join_all(futures).await;

    Ok(json!({ "requests": requests, "results": results }))
}

// HTTP handler: POST /v1/bodybuilder
// ---------------------------------------------------------------------------

/// Request body for `/v1/bodybuilder`. Mirrors the TS contract:
/// `{job, max_requests?, execute?}`. Autonomous by default (the caller sends
/// the prompt and gets answers); `execute: false` restores bodies-only.
#[derive(Debug, Deserialize)]
pub struct BodybuilderRequest {
	pub job:          Option<String>,
	pub max_requests: Option<usize>,
	#[serde(default)]
	pub execute:      Option<bool>,
}

/// Axum handler for `POST /v1/bodybuilder`. Registered BEFORE the
/// `/v1/{*path}` wildcard in `lib.rs` so the literal path wins. Carries the
/// same gates as the rest of the `/v1` surface: 503 until first-time setup
/// completes, 401 without a valid client Bearer <redacted> keyed mode.
pub async fn bodybuilder(
	State(state): State<Arc<AppState>>,
	headers: HeaderMap,
	Json(req): Json<BodybuilderRequest>,
) -> Response {
	// Fail closed until first-time setup completes (same as /v1/*).
	if state
		.setup_required
		.load(std::sync::atomic::Ordering::SeqCst)
	{
		return crate::auth::setup_required_json();
	}
	// Client auth mirrors proxy::handle: open mode admits everyone as local;
	// keyed mode hashes the presented Bearer <redacted> compares against the
	// stored SHA-256 digests with constant-time comparison.
	match &state.cfg().clients {
		None => {},
		Some(clients) => {
			let token = headers
				.get(header::AUTHORIZATION)
				.and_then(|v| v.to_str().ok())
				.and_then(|s| s.strip_prefix("Bearer "))
				.unwrap_or("");
			let digest = crate::auth::sha256_hex(token);
			if !clients
				.keys()
				.any(|stored| crate::auth::ct_eq(&digest, stored))
			{
				return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" })))
					.into_response();
			}
		},
	}

	let job = req.job.unwrap_or_default();
	if job.trim().is_empty() {
		return (StatusCode::BAD_REQUEST, Json(json!({ "error": "missing job" }))).into_response();
	}
	let max_requests = normalize_max_requests(req.max_requests);
	// TS: autonomous unless `execute === false`.
	let execute = req.execute.unwrap_or(true);
	let out = run_bodybuilder_autonomous(&job, Some(max_requests), execute, &state).await;
	match out {
		Ok(v) => (StatusCode::OK, Json(v)).into_response(),
		Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e.to_string() }))).into_response(),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn clamp_ranges() {
		assert_eq!(normalize_max_requests(None), 4);
		assert_eq!(normalize_max_requests(Some(0)), 1);
		assert_eq!(normalize_max_requests(Some(3)), 3);
		assert_eq!(normalize_max_requests(Some(100)), 16);
	}

	#[test]
	fn chunk_small_job_is_single() {
		let chunks = chunk_job_text("hello", 800_000);
		assert_eq!(chunks, vec!["hello".to_string()]);
	}

	#[test]
	fn chunk_splits_paragraphs() {
		let job = (0..10)
			.map(|i| format!("paragraph {i} with some words"))
			.collect::<Vec<_>>()
			.join("\n\n");
		let chunks = chunk_job_text(&job, 60);
		assert!(chunks.len() > 1);
		for c in &chunks {
			assert!(c.len() <= 60, "chunk too long: {c:?}");
		}
		let rejoined = chunks.join("\n\n");
		assert_eq!(rejoined, job);
	}

	#[test]
	fn chunk_hard_splits_pathological() {
		let job = "x".repeat(100);
		let chunks = chunk_job_text(&job, 30);
		assert_eq!(chunks.len(), 4);
		assert_eq!(chunks.concat(), job);
	}

	#[test]
	fn merge_never_drops_content() {
		let chunks: Vec<String> = (0..7).map(|i| format!("c{i}")).collect();
		let merged = merge_chunks_to_fit(chunks, 3);
		assert!(merged.len() <= 3);
		let all = merged.join("\n\n");
		for i in 0..7 {
			assert!(all.contains(&format!("c{i}")));
		}
	}

	#[test]
	fn sanitize_clamps_sampling() {
		let reqs = vec![json!({
			 "model": "auto",
			 "messages": [],
			 "temperature": 9.5,
			 "max_tokens": 999_999,
		})];
		let out = sanitize_requests(reqs, None, 16);
		assert_eq!(out[0]["temperature"], json!(2.0));
		assert_eq!(out[0]["max_tokens"], json!(32000));
	}

	#[test]
	fn sanitize_enforces_allow_list() {
		let allow = vec!["groq/llama-3.3-70b-versatile".to_string()];
		let reqs = vec![json!({ "model": "openai/gpt-4o", "messages": [] })];
		let out = sanitize_requests(reqs, Some(&allow), 16);
		assert_eq!(out[0]["model"], json!("groq/llama-3.3-70b-versatile"));
	}

	#[test]
	fn chunked_bodies_shape() {
		let job = "x".repeat(1_700_000);
		let bodies = chunked_request_bodies(&job, 4);
		assert!(!bodies.is_empty());
		assert!(bodies.len() <= 4);
		let first = bodies[0]["messages"][0]["content"].as_str().unwrap();
		assert!(first.starts_with("PART 1/"));
	}
}
