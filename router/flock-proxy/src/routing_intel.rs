//! Routing intelligence ported from the estate-scripts-router TypeScript
//! (`estate-scripts-router-ts/router_config.ts` + `router_strategy.ts`): task
//! classification, cost tiers, free-pool candidate selection, and the
//! model-selection / failover helpers behind `routeFree` and `routeAuto`.
//!
//! Everything here is pure decision logic. The live runtime state the TS
//! reads (circuit health, key material, catalog membership, bench bonuses)
//! is supplied by the caller through the input structs, so this module stays
//! decoupled from [`crate::router`]: it **complements** the existing
//! `Strategy` machinery — which already knows how to *execute* hybrid,
//! ast_race, and free lanes — with the *selection intelligence* the TS
//! router-max track grew: which lane a task belongs in, which models cost
//! nothing, and in what order the free pool should be tried.
//!
//! No new dependencies: the TS regexes are hand-rolled with plain string
//! matching (`regex` is not in the crate's dependency set).
//!
//! Source map (TS -> Rust):
//! - `classifyTask` / `isAst` / `AST_RE` / `REASONING_RE` -> [`classify_task`], [`is_ast`]
//! - `costTier` / `modelFree` -> [`cost_tier`], [`model_free`]
//! - `freeCandidates` -> [`free_candidate_plan`]
//! - `routeFree` -> [`route_free_plan`] (planning half; the race itself is
//!   the existing `Strategy::AstRace` path in `router.rs`)
//! - `routeFreeChain` / `sequentialFailover` -> [`free_chain_order`] +
//!   [`should_failover`] (chain *execution* lives in the caller)
//! - `routeAuto` -> [`auto_lane`] (lane-selection half; lane execution is
//!   the existing `Strategy` dispatch)
//! - `parseStickyOpt` -> [`parse_sticky_opt`]
//! - `isChatCapable` -> [`is_chat_capable`]
//! - `matchModelOnProvider` / `normalizeModelSpec` ->
//!   [`match_model_on_provider`], [`normalize_model_spec`]
//! - `shouldFailover` -> [`should_failover`]

// Dead-code is allowed: this is a decision-logic library module; its public
// API is consumed once the router integration lands (Worker C / follow-up).
#![allow(dead_code)]

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Small case-insensitive matchers (hand-rolled regex fragments)
// ---------------------------------------------------------------------------

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Case-insensitive substring search.
fn contains_ci(hay: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let hay = hay.to_lowercase();
    let needle = needle.to_lowercase();
    hay.contains(&needle)
}

/// Case-insensitive phrase search with `\b` semantics on both ends: the
/// match must not be glued to an alphanumeric/`_` char on either side.
/// Mirrors `\bword\b` and `\bmulti word phrase\b` from the TS regexes.
fn contains_word_ci(hay: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let hay: Vec<char> = hay.to_lowercase().chars().collect();
    let needle: Vec<char> = needle.to_lowercase().chars().collect();
    if hay.len() < needle.len() {
        return false;
    }
    for i in 0..=(hay.len() - needle.len()) {
        if hay[i..i + needle.len()] == needle[..] {
            let before_ok = i == 0 || !is_word_char(hay[i - 1]);
            let after_ok = i + needle.len() == hay.len() || !is_word_char(hay[i + needle.len()]);
            if before_ok && after_ok {
                return true;
            }
        }
    }
    false
}

/// First `n` characters of `s` (JS `slice(0, n)` is code-unit based; char
/// based is the faithful-enough Rust equivalent for detector input).
fn first_n_chars(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

// ---------------------------------------------------------------------------
// Task-type classification (router-max): finer than the old isAst boolean.
// code -> ast_race lane; reasoning -> deliberative hybrid lane; chat -> free
// race. The detector is cheap and deterministic (string matching, no LLM).
// ---------------------------------------------------------------------------

/// `TaskType` from `router_config.ts`: `"code" | "reasoning" | "chat"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskType {
    Code,
    Reasoning,
    Chat,
}

impl TaskType {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskType::Code => "code",
            TaskType::Reasoning => "reasoning",
            TaskType::Chat => "chat",
        }
    }
}

/// `AST_RE` from `router_config.ts`, case-insensitive alternation, matched
/// against the first 5000 chars. (Faithful quirk: `ast` has no word
/// boundary, so e.g. "fast" matches — same as the TS regex.)
const AST_TOKENS: &[&str] = &[
    "def ",
    "class ",
    "import ",
    "from ",
    "function ",
    "const ",
    "let ",
    "var ",
    "#include",
    "package ",
    "fn ",
    "pub ",
    "struct ",
    "impl ",
    "async ",
    "await ",
    ".ts",
    ".py",
    ".rs",
    ".js",
    "ast",
    "tree-sitter",
    "syntax",
];

/// `isAst(text)`: `AST_RE.test(text.slice(0, 5000)) || text.includes("```")`.
/// Note the backtick fence check runs on the *full* text in TS, not the
/// 5000-char window — preserved here.
pub fn is_ast(text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    let head = first_n_chars(text, 5000);
    AST_TOKENS.iter().any(|t| contains_ci(head, t)) || text.contains("```")
}

/// `REASONING_RE` fragments: `\b`-delimited words/phrases vs. raw
/// case-insensitive substrings, exactly as the TS alternation is shaped.
const REASONING_WORDS: &[&str] = &[
    "prove",
    "theorem",
    "derive",
    "derivation",
    "calculate",
    "computation",
    "algorithm",
    "complexity",
    "debug",
    "optimize",
    "optimization",
];

const REASONING_PHRASES: &[&str] = &["why does", "explain why", "design decision"];

const REASONING_RAW: &[&str] = &[
    "step by step",
    "step-by-step",
    "step by-step",
    "step-by step",
    "chain of thought",
    "chain-of-thought",
    "tradeoff",
    "trade off",
    "trade-off",
];

/// `classifyTask(text)`: code-shaped -> [`TaskType::Code`], reasoning-shaped
/// -> [`TaskType::Reasoning`], everything else (including empty) -> Chat.
pub fn classify_task(text: &str) -> TaskType {
    if is_ast(text) {
        return TaskType::Code;
    }
    if !text.is_empty() {
        let head = first_n_chars(text, 5000);
        let reasoning = REASONING_WORDS.iter().any(|w| contains_word_ci(head, w))
            || REASONING_PHRASES.iter().any(|p| contains_word_ci(head, p))
            || REASONING_RAW.iter().any(|r| contains_ci(head, r));
        if reasoning {
            return TaskType::Reasoning;
        }
    }
    TaskType::Chat
}

// ---------------------------------------------------------------------------
// Cost-tier awareness (router-max): what this (provider, model) costs us.
// free     — modelFree: live metadata prices it at 0 (or `:free` convention;
//            local zero-cost lanes are always free).
// cheap    — sigma cost metadata <= $1/1M input tokens.
// standard — anything else with a price we know.
// ---------------------------------------------------------------------------

/// `CostTier` from `router_config.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CostTier {
    Free,
    Cheap,
    Standard,
}

impl CostTier {
    pub fn as_str(self) -> &'static str {
        match self {
            CostTier::Free => "free",
            CostTier::Cheap => "cheap",
            CostTier::Standard => "standard",
        }
    }
}

/// Live per-model cost metadata feeding [`model_free`] / [`cost_tier`].
/// Mirrors the three sources TS consults: live `/models` pricing metadata,
/// the provider-set `free` boolean, and the sigma cost catalog.
#[derive(Debug, Clone, Default)]
pub struct ModelCostMeta {
    /// Live `/models` `pricing` object, `(prompt, completion)`. `Some` only
    /// when the live object carries pricing; both legs must be exactly zero
    /// for the model to be free (TS `v === "0" || v === 0`).
    pub pricing: Option<(f64, f64)>,
    /// Provider-set boolean `free` flag in the live metadata object.
    pub free_flag: Option<bool>,
    /// Sigma cost catalog: input $/1M tokens. `Some(x)` with `x <= 1.0` is
    /// the `cheap` tier.
    pub input_per_million: Option<f64>,
    /// Provider needs no auth (TS `PROVIDERS[p]?.no_auth`): always zero-cost.
    pub provider_no_auth: bool,
}

/// `modelFree(p, mid)`: live metadata wins (prompt + completion priced "0"
/// means zero-cost on our key; a provider-set boolean `free` flag is honored
/// too); deterministic fallback is the `:free` suffix convention, so the pool
/// never silently empties on a bad discovery refresh.
pub fn model_free(model: &str, meta: &ModelCostMeta) -> bool {
    if let Some((prompt, completion)) = meta.pricing {
        return prompt == 0.0 && completion == 0.0;
    }
    if let Some(f) = meta.free_flag {
        return f;
    }
    model.contains(":free")
}

/// `costTier(p, mid)`: local zero-cost lanes are always free even when live
/// metadata carries no pricing; then cheap (<= $1/1M input), else standard.
pub fn cost_tier(provider: &str, model: &str, meta: &ModelCostMeta) -> CostTier {
    if provider == "llama-swap" || meta.provider_no_auth || model_free(model, meta) {
        return CostTier::Free;
    }
    if let Some(ipm) = meta.input_per_million {
        return if ipm <= 1.0 {
            CostTier::Cheap
        } else {
            CostTier::Standard
        };
    }
    CostTier::Standard
}

// ---------------------------------------------------------------------------
// Chat-capability filter: guard, embedding, reranker, moderation, reward, and
// classifier models return scores/labels/vectors, not chat text — they must
// never enter chat candidate pools.
// ---------------------------------------------------------------------------

const NON_CHAT_RAW: &[&str] = &[
    "prompt-guard",
    "llama-guard",
    "safeguard",
    "embedding",
    "embedder",
    "rerank",
    "moderation",
    "toxicity",
    "reward-model",
    "classifier",
    "nsfw",
];

const NON_CHAT_WORDS: &[&str] = &["guard", "reward"];

/// `isChatCapable(mid)`.
pub fn is_chat_capable(model: &str) -> bool {
    !NON_CHAT_RAW.iter().any(|p| contains_ci(model, p))
        && !NON_CHAT_WORDS.iter().any(|w| contains_word_ci(model, w))
}

// ---------------------------------------------------------------------------
// Free-pool candidate selection (`freeCandidates` / `routeFree`)
// ---------------------------------------------------------------------------

/// The Ling-first default that leads the free pool (TS `LING_DEFAULT`).
pub const LING_DEFAULT_PROVIDER: &str = "openrouter";
pub const LING_DEFAULT_MODEL: &str = "inclusionai/ling-3.0-flash-fin:free";

/// One model offered to the free-pool planner: static eligibility flags plus
/// the bench-derived quality bonus used for ordering.
#[derive(Debug, Clone)]
pub struct FreePoolModel {
    pub id: String,
    /// Empty-output "flap" strikes not yet decayed — sits out.
    pub flap_banned: bool,
    /// 404 entitlement bench — sits out for the process lifetime.
    pub entitlement_dead: bool,
    /// [`model_free`] verdict for this provider/model.
    pub free: bool,
    /// Bench-derived quality bonus (router-max: roundup benchmark data
    /// steers candidate order; tie-break scale).
    pub bench_bonus: f64,
}

/// One provider offered to the free-pool planner: health flags from the
/// router's runtime state (TS `keyOk` / `state.circuitOk` /
/// `state.laneDead`) plus its catalog models.
#[derive(Debug, Clone)]
pub struct FreePoolProvider {
    pub name: String,
    /// Has usable key material (or needs none) — TS `keyOk(name)`.
    pub key_ok: bool,
    /// Circuit allows traffic — TS `state.circuitOk(name)`.
    pub circuit_ok: bool,
    /// Dead lane: its free models race only as degraded fallback — TS
    /// `state.laneDead(name)`.
    pub lane_dead: bool,
    pub models: Vec<FreePoolModel>,
}

/// Local zero-cost role ids (TS `LOCAL_ROLES` fast/quality/longctx).
#[derive(Debug, Clone)]
pub struct LocalRoles {
    pub fast: String,
    pub quality: String,
    pub longctx: String,
}

/// Local-lane membership flags for the free pool (TS: `keyOk("llama-swap")`
/// and `state.laneDead("llama-swap")`).
#[derive(Debug, Clone)]
pub struct LocalLanes {
    pub roles: LocalRoles,
    /// `keyOk("llama-swap") && !laneDead("llama-swap")`: roles join the live pool.
    pub live: bool,
    /// `keyOk("llama-swap")`: roles join the degraded dead-pool fallback.
    pub key_ok: bool,
}

fn push_local_roles(pool: &mut Vec<(String, String, f64)>, lanes: &LocalLanes) {
    // Local roles carry no bench bonus of their own; 0.0 keeps them in
    // catalog order among the bonus-ranked cloud candidates.
    for role in [&lanes.roles.fast, &lanes.roles.quality, &lanes.roles.longctx] {
        pool.push(("llama-swap".to_string(), role.clone(), 0.0));
    }
}

/// `freeCandidates()`: the free pool derived from live catalog metadata.
/// For every keyed provider with a healthy circuit, every catalog id whose
/// live metadata marks it free ([`model_free`]) joins the pool. Filters:
/// circuit state, flap-benched and entitlement-benched models, dead lanes
/// (held as degraded fallback), and the chat-capability filter. Router-max:
/// ordered by bench-derived quality bonus, with the Ling-first pin leading.
pub fn free_candidate_plan(
    providers: &[FreePoolProvider],
    local: &LocalLanes,
) -> Vec<(String, String)> {
    let mut out: Vec<(String, String, f64)> = Vec::new();
    let mut dead_out: Vec<(String, String, f64)> = Vec::new();
    for p in providers {
        if !p.key_ok || !p.circuit_ok {
            continue;
        }
        // Dead-lane exclusion: same rule as pickWeighted — dead lanes sit
        // out unless nothing else is alive.
        let bucket = if p.lane_dead { &mut dead_out } else { &mut out };
        for m in &p.models {
            if m.flap_banned || m.entitlement_dead {
                continue;
            }
            if !is_chat_capable(&m.id) {
                continue;
            }
            if m.free {
                bucket.push((p.name.clone(), m.id.clone(), m.bench_bonus));
            }
        }
    }
    if local.live {
        push_local_roles(&mut out, local);
    }
    // Degraded mode: every lane is dead — race the dead pool anyway rather
    // than serve 503.
    let mut pool: Vec<(String, String, f64)> = if out.is_empty() { dead_out } else { out };
    if pool.is_empty() && local.key_ok {
        push_local_roles(&mut pool, local);
    }
    // Router-max: order by bench-derived quality bonus, descending (stable —
    // ties keep catalog order, like V8's stable sort).
    pool.sort_by(|a, b| {
        b.2.partial_cmp(&a.2)
            .unwrap_or(Ordering::Equal)
    });
    // Ling-first default: Ling leads the free pool so the `free` race
    // prefers it. A flap-banned Ling still sat out above; the substance
    // guard still skips empty completions downstream.
    if let Some(idx) = pool
        .iter()
        .position(|(p, m, _)| p == LING_DEFAULT_PROVIDER && m == LING_DEFAULT_MODEL)
    {
        if idx > 0 {
            let ling = pool.remove(idx);
            pool.insert(0, ling);
        }
    }
    pool.into_iter().map(|(p, m, _)| (p, m)).collect()
}

/// `routeFree` planning half: the ordered free+local candidate pool the
/// race machinery should fan out over. `None` when the pool is empty — the
/// TS 503 `"no_free_providers"` case; the actual parallel race is the
/// existing `Strategy::AstRace` path in `router.rs`.
pub fn route_free_plan(
    providers: &[FreePoolProvider],
    local: &LocalLanes,
) -> Option<Vec<(String, String)>> {
    let pool = free_candidate_plan(providers, local);
    if pool.is_empty() {
        None
    } else {
        Some(pool)
    }
}

/// `routeFreeChain` ordering: the free pool as an ordered auto-switch chain.
/// Same candidate order as [`free_candidate_plan`]; the chain *execution*
/// (sequential attempts + [`should_failover`] gating) lives in the caller.
pub fn free_chain_order(
    providers: &[FreePoolProvider],
    local: &LocalLanes,
) -> Vec<(String, String)> {
    free_candidate_plan(providers, local)
}

// ---------------------------------------------------------------------------
// Auto-switch failover predicate (`shouldFailover`)
// ---------------------------------------------------------------------------

/// Raw case-insensitive alternation arms of `FAILOVER_ERR_RE`.
const FAILOVER_RAW: &[&str] = &[
    "timeout",
    "rate_limit",
    "rate limited",
    "governor_limited",
    "buckets_exhausted",
    "fetch_error",
    "temporar",
    "entitlement_benched",
    "circuit_open",
    "overloaded",
    "too many",
];

/// `X.?Y` arm: `a` followed by `b` with zero or one char between.
fn fuzzy_pair(hay: &str, a: &str, b: &str) -> bool {
    let mut start = 0;
    while let Some(i) = hay[start..].find(a) {
        let i = start + i;
        let rest = &hay[i + a.len()..];
        if rest.starts_with(b) {
            return true;
        }
        if let Some(c) = rest.chars().next() {
            if rest[c.len_utf8()..].starts_with(b) {
                return true;
            }
        }
        start = i + 1;
    }
    false
}

/// `shouldFailover(r)`: a failed attempt is failover-eligible (chain moves to
/// the next candidate) on 429+, on 404 entitlement-bench, or when the error
/// string matches the transient-failure alternation. Terminal failures
/// (400 malformed, auth) stop the chain — retrying the same body everywhere
/// would just burn the pool.
pub fn should_failover(ok: bool, status: Option<u16>, err: Option<&str>) -> bool {
    if ok {
        return false;
    }
    if status.is_some_and(|s| s >= 429) {
        return true;
    }
    if status == Some(404) && err.is_some_and(|e| e.contains("entitlement_benched")) {
        return true;
    }
    let e = match err {
        Some(e) => e.to_lowercase(),
        None => return false,
    };
    FAILOVER_RAW.iter().any(|p| e.contains(p))
        || fuzzy_pair(&e, "worker", "exhaust") // worker.?exhaust
        || fuzzy_pair(&e, "resource", "exhaust") // resource.?exhaust
}

// ---------------------------------------------------------------------------
// routeAuto lane selection: the task type picks the lane.
// ---------------------------------------------------------------------------

/// Which lane `routeAuto` would run for a classified task. Lane *execution*
/// is the existing `Strategy` dispatch in `router.rs`; this enum is the
/// selection decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoLane {
    /// code-shaped: AST-priority race over the context-filtered weighted field.
    AstRace,
    /// reasoning: deliberative ordered hybrid chain with failover.
    HybridChain,
    /// chat (default): free race first (zero cost), then the ordered
    /// auto-switch free chain, then the hybrid fallback — the request
    /// degrades, never fails hard.
    FreeThenHybrid,
}

/// `routeAuto`'s dispatch decision from the classified [`TaskType`].
/// Callers can stamp the TS `task_type` / `cost_tier` fields with
/// [`TaskType::as_str`] + [`cost_tier`].
pub fn auto_lane(task: TaskType) -> AutoLane {
    match task {
        TaskType::Code => AutoLane::AstRace,
        TaskType::Reasoning => AutoLane::HybridChain,
        TaskType::Chat => AutoLane::FreeThenHybrid,
    }
}

// ---------------------------------------------------------------------------
// Model-selection helpers
// ---------------------------------------------------------------------------

/// `parseStickyOpt` — `X-estate-scripts-Sticky` header parsing: "1"/"true"/"yes"/
/// "on" -> opt-in; "0"/"false"/"no"/"off" -> opt-out; absent/unparseable ->
/// `None` (legacy behavior).
pub fn parse_sticky_opt(h: Option<&str>) -> Option<bool> {
    let v = h?.trim().to_lowercase();
    match v.as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// `matchModelOnProvider(p, rest)`: best catalog model id on provider `p`
/// matching a loose name. Exact catalog hit wins; otherwise compare the
/// tag-stripped (`:free` etc.) basename after `/`, case-insensitively.
pub fn match_model_on_provider(catalog: &[String], rest: &str) -> Option<String> {
    let r = rest.trim();
    if r.is_empty() {
        return None;
    }
    if catalog.iter().any(|m| m == r) {
        return Some(r.to_string());
    }
    let base = |m: &str| {
        m.split(':')
            .next()
            .unwrap_or(m)
            .rsplit('/')
            .next()
            .unwrap_or(m)
            .to_lowercase()
    };
    let r_base = base(r);
    catalog.iter().find(|m| base(m) == r_base).cloned()
}

/// `normalizeModelSpec(spec)`: split a user-supplied model spec into
/// `(Option<provider>, model)`.
/// - empty -> `(None, "auto")`
/// - `CODING` alias (caller-supplied predicate) -> passes through untouched
/// - bare model id already in some provider's catalog -> provider-agnostic
/// - `"provider:model"` colon form -> provider + best catalog match
/// - `"provider/rest/of/id"` slash form -> provider + exact or best match
/// - otherwise -> `(None, spec)` verbatim
pub fn normalize_model_spec(
    spec: &str,
    provider_names: &[String],
    coding_aliases: &dyn Fn(&str) -> bool,
    catalog_for: &dyn Fn(&str) -> Vec<String>,
) -> (Option<String>, String) {
    let s = spec.trim();
    if s.is_empty() {
        return (None, "auto".to_string());
    }
    if coding_aliases(s) {
        return (None, s.to_string());
    }
    let in_catalog =
        |p: &str, m: &str| -> bool { catalog_for(p).iter().any(|x| x == m) };
    if provider_names.iter().any(|p| in_catalog(p, s)) {
        return (None, s.to_string());
    }
    // "provider:model" colon form (the exact shape the fork mangles).
    if let Some(ci) = s.find(':') {
        if ci > 0 {
            let pre = s[..ci].to_lowercase();
            if provider_names.iter().any(|p| p == &pre) {
                let rest = &s[ci + 1..];
                if let Some(mid) = match_model_on_provider(&catalog_for(&pre), rest) {
                    return (Some(pre), mid);
                }
            }
        }
    }
    // "provider/rest/of/id" slash form, e.g. "openrouter/openai/gpt-oss-20b:free".
    if let Some(si) = s.find('/') {
        if si > 0 {
            let pre = s[..si].to_lowercase();
            if provider_names.iter().any(|p| p == &pre) {
                let rest = &s[si + 1..];
                if in_catalog(&pre, rest) {
                    return (Some(pre), rest.to_string());
                }
                if let Some(mid) = match_model_on_provider(&catalog_for(&pre), rest) {
                    return (Some(pre), mid);
                }
            }
        }
    }
    (None, s.to_string())
}


// ---------------------------------------------------------------------------
// Prompt text extraction
// ---------------------------------------------------------------------------

/// `bodyPromptText` from `router_strategy.ts`: the last message's content --
/// the freshest user turn, which is what `classifyTask` reads. Handles both
/// plain string content and the parts-array shape (`[{text: ...}]`).
pub fn prompt_text(body: &[u8]) -> String {
    let v: serde_json::Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => return String::new(),
    };
    let msgs = match v.get("messages").and_then(|m| m.as_array()) {
        Some(m) => m,
        None => return String::new(),
    };
    for msg in msgs.iter().rev() {
        let content = match msg.get("content") {
            Some(c) => c,
            None => continue,
        };
        if let Some(s) = content.as_str() {
            if !s.is_empty() {
                return s.to_owned();
            }
        } else if let Some(parts) = content.as_array() {
            let mut t = String::new();
            for part in parts {
                if let Some(s) = part.get("text").and_then(|t| t.as_str()) {
                    if !t.is_empty() {
                        t.push('\n');
                    }
                    t.push_str(s);
                }
            }
            let t = t.trim().to_owned();
            if !t.is_empty() {
                return t;
            }
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Mirrors estate-scripts-router-ts/tests/router_max.test.ts expectations.

    #[test]
    fn classify_code_snippets() {
        assert_eq!(classify_task("def foo():\n    return 42"), TaskType::Code);
        assert_eq!(classify_task("```python\nprint(1)\n```"), TaskType::Code);
        assert_eq!(
            classify_task("here is the tree-sitter grammar"),
            TaskType::Code
        );
    }

    #[test]
    fn classify_reasoning_phrases() {
        assert_eq!(
            classify_task("Prove that P != NP step by step"),
            TaskType::Reasoning
        );
        assert_eq!(
            classify_task("Explain why the trade-off favors latency here"),
            TaskType::Reasoning
        );
        assert_eq!(
            classify_task("What is the time complexity of this algorithm?"),
            TaskType::Reasoning
        );
    }

    #[test]
    fn classify_chat_default() {
        assert_eq!(classify_task("what is the weather today"), TaskType::Chat);
        assert_eq!(classify_task(""), TaskType::Chat);
    }

    #[test]
    fn cost_tier_cases() {
        let none = ModelCostMeta::default();
        assert_eq!(
            cost_tier("openrouter", "some-model:free", &none),
            CostTier::Free
        );
        assert_eq!(
            cost_tier("llama-swap", "beellama/exaone-4-0-1-2b-iq4xs", &none),
            CostTier::Free
        );
        let cheap = ModelCostMeta {
            input_per_million: Some(0.6),
            ..Default::default()
        };
        assert_eq!(
            cost_tier("baseten", "moonshotai/Kimi-K2.6", &cheap),
            CostTier::Cheap
        );
        assert_eq!(
            cost_tier("openrouter", "x-ai/grok-4.20", &none),
            CostTier::Standard
        );
        // Live pricing wins: both legs zero -> free even without :free.
        let zero_priced = ModelCostMeta {
            pricing: Some((0.0, 0.0)),
            ..Default::default()
        };
        assert_eq!(
            cost_tier("openrouter", "stealth/union-alpha", &zero_priced),
            CostTier::Free
        );
        // Pricing present but non-zero -> standard.
        let priced = ModelCostMeta {
            pricing: Some((1.5, 6.0)),
            input_per_million: Some(1.5),
            ..Default::default()
        };
        assert_eq!(
            cost_tier("openrouter", "x-ai/grok-4.20", &priced),
            CostTier::Standard
        );
    }

    #[test]
    fn chat_capability_filter() {
        assert!(!is_chat_capable(
            "meta-llama/llama-prompt-guard-2-86m"
        ));
        assert!(!is_chat_capable("some-org/text-embedding-3-large"));
        assert!(!is_chat_capable("cohere/rerank-english-v3"));
        assert!(is_chat_capable("inclusionai/ling-3.0-flash-fin:free"));
        assert!(is_chat_capable("beellama/qwen-flash-64k"));
    }

    #[test]
    fn sticky_opt_parsing() {
        assert_eq!(parse_sticky_opt(Some("1")), Some(true));
        assert_eq!(parse_sticky_opt(Some("yes")), Some(true));
        assert_eq!(parse_sticky_opt(Some("off")), Some(false));
        assert_eq!(parse_sticky_opt(None), None);
        assert_eq!(parse_sticky_opt(Some("maybe")), None);
    }

    #[test]
    fn failover_predicate() {
        assert!(!should_failover(true, Some(200), None));
        assert!(should_failover(false, Some(429), Some("rate limited")));
        assert!(should_failover(false, Some(503), Some("overloaded")));
        assert!(should_failover(
            false,
            Some(404),
            Some("entitlement_benched: model not on key")
        ));
        assert!(should_failover(false, Some(500), Some("fetch_error")));
        assert!(should_failover(
            false,
            Some(500),
            Some("worker exhausted")
        ));
        // Terminal: 400 malformed stops the chain.
        assert!(!should_failover(false, Some(400), Some("malformed request")));
        assert!(!should_failover(false, Some(401), Some("bad key")));
    }

    fn test_pool() -> (Vec<FreePoolProvider>, LocalLanes) {
        let providers = vec![
            FreePoolProvider {
                name: "openrouter".into(),
                key_ok: true,
                circuit_ok: true,
                lane_dead: false,
                models: vec![
                    FreePoolModel {
                        id: "inclusionai/ling-3.0-flash-fin:free".into(),
                        flap_banned: false,
                        entitlement_dead: false,
                        free: true,
                        bench_bonus: 2.0,
                    },
                    FreePoolModel {
                        id: "other/free-model:free".into(),
                        flap_banned: false,
                        entitlement_dead: false,
                        free: true,
                        bench_bonus: 9.0, // higher bonus, but Ling pin still leads
                    },
                    FreePoolModel {
                        id: "meta-llama/prompt-guard-2:free".into(),
                        flap_banned: false,
                        entitlement_dead: false,
                        free: true,
                        bench_bonus: 50.0, // filtered: not chat-capable
                    },
                    FreePoolModel {
                        id: "flappy/model:free".into(),
                        flap_banned: true, // filtered: flap bench
                        entitlement_dead: false,
                        free: true,
                        bench_bonus: 99.0,
                    },
                    FreePoolModel {
                        id: "openai/gpt-5".into(),
                        flap_banned: false,
                        entitlement_dead: false,
                        free: false, // filtered: not free
                        bench_bonus: 99.0,
                    },
                ],
            },
            FreePoolProvider {
                name: "groq".into(),
                key_ok: true,
                circuit_ok: true,
                lane_dead: true, // dead lane -> degraded fallback only
                models: vec![FreePoolModel {
                    id: "groq/dead-lane-free:free".into(),
                    flap_banned: false,
                    entitlement_dead: false,
                    free: true,
                    bench_bonus: 1.0,
                }],
            },
        ];
        let local = LocalLanes {
            roles: LocalRoles {
                fast: "beellama/exaone-4-0-1-2b-iq4xs".into(),
                quality: "beellama/qwen-flash-64k".into(),
                longctx: "beellama/qwen-flash-256k".into(),
            },
            live: true,
            key_ok: true,
        };
        (providers, local)
    }

    #[test]
    fn free_pool_ordering_and_filters() {
        let (providers, local) = test_pool();
        let pool = free_candidate_plan(&providers, &local);
        let ids: Vec<(&str, &str)> =
            pool.iter().map(|(p, m)| (p.as_str(), m.as_str())).collect();
        // Ling leads despite the lower bench bonus (Ling-first pin).
        assert_eq!(
            ids[0],
            ("openrouter", "inclusionai/ling-3.0-flash-fin:free")
        );
        // Guard/embedding models never enter the pool; flap-banned sits out;
        // non-free models excluded.
        assert!(!ids.iter().any(|(_, m)| m.contains("prompt-guard")));
        assert!(!ids.iter().any(|(_, m)| m.contains("flappy")));
        assert!(!ids.iter().any(|(_, m)| m.contains("gpt-5")));
        // Local zero-cost roles join the live pool.
        assert!(ids
            .iter()
            .any(|(p, m)| *p == "llama-swap" && m.contains("exaone")));
        // Dead lane's model is held back while the live pool is non-empty.
        assert!(!ids.iter().any(|(_, m)| m.contains("dead-lane-free")));
        // Bench bonus orders the rest: other/free-model (9.0) before locals (0.0).
        let pos_other = ids
            .iter()
            .position(|(_, m)| m.contains("other/free-model"))
            .unwrap();
        let pos_local = ids
            .iter()
            .position(|(p, _)| *p == "llama-swap")
            .unwrap();
        assert!(pos_other < pos_local);
    }

    #[test]
    fn free_pool_degraded_dead_fallback() {
        let (mut providers, mut local) = test_pool();
        for p in &mut providers {
            p.lane_dead = true;
        }
        local.live = false; // llama-swap lane dead too
        let pool = free_candidate_plan(&providers, &local);
        // Degraded mode: race the dead pool anyway rather than serve 503.
        assert!(pool
            .iter()
            .any(|(_, m)| m.contains("dead-lane-free")));
    }

    #[test]
    fn route_free_empty_is_none() {
        let local = LocalLanes {
            roles: LocalRoles {
                fast: "a".into(),
                quality: "b".into(),
                longctx: "c".into(),
            },
            live: false,
            key_ok: false,
        };
        assert!(route_free_plan(&[], &local).is_none());
    }

    #[test]
    fn normalize_spec_forms() {
        let names = vec!["openrouter".to_string(), "nvidia".to_string()];
        let aliases = |s: &str| matches!(s, "auto" | "free" | "fast");
        let catalog = |p: &str| -> Vec<String> {
            match p {
                "openrouter" => vec![
                    "openai/gpt-oss-20b:free".to_string(),
                    "inclusionai/ling-3.0-flash-fin:free".to_string(),
                ],
                _ => vec![],
            }
        };
        assert_eq!(
            normalize_model_spec("", &names, &aliases, &catalog),
            (None, "auto".to_string())
        );
        assert_eq!(
            normalize_model_spec("free", &names, &aliases, &catalog),
            (None, "free".to_string())
        );
        // Bare id in a catalog -> provider-agnostic.
        assert_eq!(
            normalize_model_spec("openai/gpt-oss-20b:free", &names, &aliases, &catalog),
            (None, "openai/gpt-oss-20b:free".to_string())
        );
        // Colon form with loose basename match.
        assert_eq!(
            normalize_model_spec("openrouter:ling-3.0-flash-fin", &names, &aliases, &catalog),
            (
                Some("openrouter".to_string()),
                "inclusionai/ling-3.0-flash-fin:free".to_string()
            )
        );
        // Unknown spec passes through verbatim.
        assert_eq!(
            normalize_model_spec("some-unknown-model", &names, &aliases, &catalog),
            (None, "some-unknown-model".to_string())
        );
    }

    #[test]
    fn auto_lane_selection() {
        assert_eq!(auto_lane(TaskType::Code), AutoLane::AstRace);
        assert_eq!(auto_lane(TaskType::Reasoning), AutoLane::HybridChain);
        assert_eq!(auto_lane(TaskType::Chat), AutoLane::FreeThenHybrid);
    }
}
