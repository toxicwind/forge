//! Provider model — Flock's multi-provider core.
//!
//! This module genuinely absorbs AstMatrix's provider registry: its 13
//! built-in provider definitions, model lists, ELO scores, weights, free-tier
//! flags, and key-resolution rules are re-expressed here as native Rust, with
//! no adapter over the old Go code. Nothing is a wrapper, alias, shim, or
//! monkey-patch; there is one implementation and it lives here.
//!
//! Fidelity notes (see `MIGRATION.md` for the full account):
//! - AstMatrix's `Provider` carried `APIKey` resolved from `KeyEnv` at
//!   startup, `NoAuth`, `FreeTier`, `Models`, `ModelMap`, `Weight`, `ELO`.
//!   All of those are real fields here.
//! - AstMatrix's `MaxParallel` was declared but never enforced by its race
//!   path; here `max_parallel` is actually enforced in the router.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Buffered-request coalescing window. AstMatrix instantiated its
/// `RequestCoalescer` with a 5 s TTL but never called it; here the TTL is
/// real and the coalescer sits on the buffered request path.
pub const COALESCER_TTL: Duration = Duration::from_secs(5);

/// Compose the upstream model-catalog URL for a provider base URL.
///
/// Roost carries OpenAI-compatible base URLs in two shapes: already-versioned
/// (`https://api.groq.com/openai/v1`, `https://api.cerebras.ai/v1`) and
/// bare-host (`https://api.mistral.ai`). Naively appending `/v1/models`
/// produced `/v1/v1/models` for the former — a 404 that silently marked every
/// such provider unhealthy, opened its circuit, and left the router with no
/// upstream at all. Strip a trailing `/v1` before appending, so both shapes
/// resolve to the same catalog URL.
pub fn models_url(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    let base = base.strip_suffix("/v1").unwrap_or(base);
    format!("{base}/v1/models")
}

/// Join a provider base URL with the incoming request path + query.
///
/// The incoming path already carries its own `/v1` segment, and Roost bases are
/// frequently versioned too (`https://api.groq.com/openai/v1`), so a plain
/// concatenation produced `/openai/v1/v1/chat/completions` — a 404
/// `unknown_url` from groq, which the router then read as an empty completion
/// and quarantined. Drop the base's trailing `/v1` when the path supplies its
/// own, and leave bare-host bases (`https://api.mistral.ai`) alone so they keep
/// gaining the prefix they need.
pub fn upstream_url(base_url: &str, path_and_query: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    // Tolerate a missing leading slash, then dedupe a trailing /v1 on the
    // base against a leading /v1 on the path (the /v1/v1 probe bug).
    let path = if path_and_query.starts_with('/') {
        path_and_query.to_string()
    } else {
        format!("/{path_and_query}")
    };
    let base = if path == "/v1" || path.starts_with("/v1/") {
        base.strip_suffix("/v1").unwrap_or(base)
    } else {
        base
    };
    format!("{base}{path}")
}

/// How a provider authenticates upstream requests.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AuthScheme {
    /// Bearer API key(s) from [`ProviderKey`].
    #[default]
    ApiKey,
    /// No `Authorization` header is sent at all.
    None,
}

/// One upstream key for a provider. Mirrors AstMatrix's per-provider key
/// resolution: an explicit key wins, otherwise `key_env` is read from the
/// process environment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderKey {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub key_env: String,
    #[serde(default = "default_owner")]
    pub owner: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Requests-per-minute budget for this key's lane. Defaults to
    /// AstMatrix's 60 RPM for paid providers, 10 RPM for free-tier ones.
    #[serde(default)]
    pub rpm: usize,
}

fn default_owner() -> String {
    "default".to_string()
}
fn default_true() -> bool {
    true
}

impl Default for ProviderKey {
    fn default() -> Self {
        Self {
            key: String::new(),
            key_env: String::new(),
            owner: default_owner(),
            enabled: true,
            rpm: 0,
        }
    }
}

/// Resolve a key record to usable key material: the literal key, falling back
/// to the environment variable. Mirrors AstMatrix's `resolveAPIKey`.
pub fn resolve_key_material(key: &ProviderKey) -> Option<String> {
    if !key.key.is_empty() {
        return Some(key.key.clone());
    }
    if !key.key_env.is_empty() {
        if let Ok(v) = std::env::var(&key.key_env) {
            let v = v.trim().to_string();
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    None
}

/// The routing strategy for a model with more than one usable provider.
/// Names intentionally match AstMatrix's configured strategy identifiers so
/// existing Herd/router configs keep meaning them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Strategy {
    /// Try candidates in order, with circuit/limiter/health gates per
    /// attempt (AstMatrix `hybrid` semantics, minus its 4xx-as-usable bug).
    #[default]
    Hybrid,
    /// Fan out to every candidate and take the first usable, non-empty,
    /// correct response (`ast_race`).
    AstRace,
    /// Prefer the session's pinned provider (`sticky_affinity`).
    StickyAffinity,
    /// ELO-weighted random choice (`weighted_elo`).
    WeightedElo,
    /// Lowest recent latency first (`least_latency`).
    LeastLatency,
    /// Simple rotation across candidates (`round_robin`).
    RoundRobin,
    /// Race only free-tier providers (`free`).
    Free,
    /// Walk candidates in order until one returns a usable response
    /// (`circuit_chain`).
    CircuitChain,
}

impl Strategy {
    /// Parse a strategy name the way Herd config files spell them.
    pub fn parse(name: &str) -> Option<Strategy> {
        match name {
            "hybrid" => Some(Strategy::Hybrid),
            "ast_race" => Some(Strategy::AstRace),
            "sticky_affinity" => Some(Strategy::StickyAffinity),
            "weighted_elo" => Some(Strategy::WeightedElo),
            "least_latency" => Some(Strategy::LeastLatency),
            "round_robin" => Some(Strategy::RoundRobin),
            "free" => Some(Strategy::Free),
            "circuit_chain" => Some(Strategy::CircuitChain),
            _ => None,
        }
    }
}

/// Provider-wide routing knobs. Serde defaults keep old configs loading.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingCfg {
    #[serde(default)]
    pub strategy: Strategy,
    /// Bounded fan-out for `ast_race` / `free`: the maximum number of
    /// concurrent upstream attempts. AstMatrix declared this but never
    /// enforced it; here it is enforced.
    #[serde(default = "default_max_parallel")]
    pub max_parallel: usize,
    /// Failover rounds across candidates before giving up.
    #[serde(default = "default_max_retries")]
    pub max_retries: usize,
    /// Sticky-affinity pin TTL, seconds.
    #[serde(default = "default_sticky_ttl")]
    pub sticky_ttl_secs: u64,
    /// Maximum coalesced buffered requests waiting (AstMatrix declared
    /// `FifoMax` but never used it; the router enforces this as the FIFO
    /// admission bound).
    #[serde(default = "default_fifo_max")]
    pub fifo_max: usize,
    /// Coalesce identical in-flight buffered requests into one upstream
    /// call. AstMatrix instantiated its coalescer but never invoked it; here
    /// it is on the request path.
    #[serde(default = "default_true")]
    pub enable_coalescing: bool,
    /// Health-probe interval, seconds. AstMatrix defaulted to 30.
    #[serde(default = "default_probe_interval")]
    pub probe_interval_secs: u64,
}

fn default_probe_interval() -> u64 {
    30
}

impl RoutingCfg {
    /// Sticky-affinity pin TTL as a `Duration`.
    pub fn sticky_ttl(&self) -> Duration {
        Duration::from_secs(self.sticky_ttl_secs.max(1))
    }

    /// Health-probe interval as a `Duration`. Zero disables probing (the
    /// router falls back to its own default).
    pub fn probe_interval(&self) -> Option<Duration> {
        if self.probe_interval_secs == 0 {
            None
        } else {
            Some(Duration::from_secs(self.probe_interval_secs))
        }
    }
}

fn default_max_parallel() -> usize {
    8
}
fn default_max_retries() -> usize {
    3
}
fn default_sticky_ttl() -> u64 {
    3600
}
fn default_fifo_max() -> usize {
    512
}

impl Default for RoutingCfg {
    fn default() -> Self {
        Self {
            strategy: Strategy::default(),
            max_parallel: default_max_parallel(),
            max_retries: default_max_retries(),
            sticky_ttl_secs: default_sticky_ttl(),
            fifo_max: default_fifo_max(),
            enable_coalescing: true,
            probe_interval_secs: default_probe_interval(),
        }
    }
}

/// One upstream provider. AstMatrix's `Provider` struct, natively.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderDef {
    /// Stable identifier: `nvidia`, `openrouter`, ... Matches AstMatrix IDs
    /// so Herd config references keep resolving.
    pub name: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub auth: AuthScheme,
    #[serde(default)]
    pub keys: Vec<ProviderKey>,
    #[serde(default)]
    pub no_auth: bool,
    #[serde(default)]
    pub free_tier: bool,
    #[serde(default)]
    pub models: Vec<String>,
    /// Upstream model id -> id to actually request. AstMatrix's `ModelMap`.
    #[serde(default)]
    pub model_map: HashMap<String, String>,
    /// ELO selection weight.
    #[serde(default = "default_weight")]
    pub weight: f64,
    /// Quality score, seeded from AstMatrix's registry values.
    #[serde(default = "default_elo")]
    pub elo: i32,
    /// Requests-per-minute budget applied when a key has `rpm == 0`.
    #[serde(default)]
    pub default_rpm: usize,
    /// Human label for the dashboard.
    #[serde(default)]
    pub display_name: String,
    /// Operational on/off switch independent of key material.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Declared context windows per model ID (tokens), from Roost.
    /// Absent = undeclared = never demoted by context-window auto-demotion.
    /// BTreeMap (not HashMap) so config JSON serialization is deterministic.
    #[serde(default)]
    pub context_lengths: std::collections::BTreeMap<String, u64>,
}

fn default_weight() -> f64 {
    1.0
}
fn default_elo() -> i32 {
    1500
}

impl Default for ProviderDef {
    fn default() -> Self {
        Self {
            context_lengths: std::collections::BTreeMap::new(),
            name: String::new(),
            base_url: String::new(),
            auth: AuthScheme::ApiKey,
            keys: Vec::new(),
            no_auth: false,
            free_tier: false,
            models: Vec::new(),
            model_map: HashMap::new(),
            weight: 1.0,
            elo: 1500,
            default_rpm: 0,
            display_name: String::new(),
            enabled: true,
        }
    }
}

impl ProviderDef {
    /// Effective RPM for a key: explicit per-key rpm, else the provider
    /// default, else AstMatrix's 60/10 rule.
    pub fn rpm_for(&self, key: &ProviderKey) -> usize {
        if key.rpm > 0 {
            return key.rpm;
        }
        if self.default_rpm > 0 {
            return self.default_rpm;
        }
        if self.free_tier {
            10
        } else {
            60
        }
    }

    /// Whether this provider can serve traffic right now: enabled, and
    /// either no-auth or at least one enabled key with resolvable material.
    pub fn usable(&self) -> bool {
        if !self.enabled {
            return false;
        }
        if self.no_auth || self.auth == AuthScheme::None {
            return true;
        }
        self.keys
            .iter()
            .any(|k| k.enabled && resolve_key_material(k).is_some())
    }

    /// Enabled keys that currently resolve to key material.
    pub fn live_keys(&self) -> Vec<(String, usize)> {
        self.keys
            .iter()
            .filter(|k| k.enabled)
            .filter_map(|k| resolve_key_material(k).map(|m| (m, self.rpm_for(k))))
            .collect()
    }

    /// Rewrite the requested model id through this provider's model map.
    /// Returns the id to actually send upstream.
    pub fn map_model<'a>(&'a self, model: &'a str) -> &'a str {
        self.model_map
            .get(model)
            .map(|s| s.as_str())
            .unwrap_or(model)
    }

    /// Owned version of [`Self::map_model`] for the router's candidates.
    pub fn rewrite_model(&self, model: &str) -> String {
        self.map_model(model).to_owned()
    }

    /// Whether this provider serves `model`: listed in `models`, or the
    /// models list carries the `"*"` wildcard (the old NVIDIA proxy passed
    /// any requested model through, and migrated providers keep that).
    pub fn serves_model(&self, model: &str) -> bool {
        self.models.iter().any(|m| m == "*" || m == model)
    }

    /// The upstream id for `model` differs from the requested one.
    pub fn model_rewritten(&self, model: &str) -> bool {
        self.model_map.contains_key(model)
    }

    /// Lane specs for this provider's key pool: one lane per key with
    /// resolvable material (literal or `key_env`), deduplicated by material.
    /// Disabled keys ride along as state carriers so a disable→enable cycle
    /// can't reset their windows — exactly the old pool's contract.
    pub fn lane_specs(&self) -> Vec<crate::pool::LaneSpec> {
        // A keyless provider (auth: none) has no key material by design: the
        // upstream proxy owns the credential. Filtering on resolve_key_material
        // would hand it zero lanes, so `active == 0`, `reserve` waits out the
        // whole window, and every request dies as a 0 ms 502. Synthesize one
        // lane so the provider can actually be granted a slot.
        if self.no_auth {
            return vec![crate::pool::LaneSpec {
                key: String::new(),
                rpm: self.rpm_for(&ProviderKey::default()),
                enabled: true,
            }];
        }
        let mut seen = std::collections::HashSet::new();
        self.keys
            .iter()
            .filter_map(|k| {
                let material = resolve_key_material(k)?;
                if material.is_empty() || !seen.insert(material.clone()) {
                    return None;
                }
                Some(crate::pool::LaneSpec {
                    key: material,
                    rpm: self.rpm_for(k),
                    enabled: k.enabled,
                })
            })
            .collect()
    }
}

/// The live provider registry with a by-model candidate index.
#[derive(Debug, Clone, Default)]
pub struct ProviderSet {
    pub providers: Vec<ProviderDef>,
    by_model: HashMap<String, Vec<usize>>,
}

impl ProviderSet {
    pub fn new(mut providers: Vec<ProviderDef>) -> Self {
        // The store author decides provider precedence; within a provider,
        // AstMatrix semantics are preserved.
        let mut by_model: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, p) in providers.iter().enumerate() {
            for m in &p.models {
                by_model.entry(m.clone()).or_default().push(i);
            }
        }
        // Wildcard entries ("" or "*") catch models no provider lists.
        let wildcards: Vec<usize> = providers
            .iter()
            .enumerate()
            .filter(|(_, p)| p.models.iter().any(|m| m == "*" || m == ""))
            .map(|(i, _)| i)
            .collect();
        if !wildcards.is_empty() {
            // stored under a sentinel; for_model merges them in
            by_model.insert(String::new(), wildcards);
        }
        let _ = &mut providers;
        Self {
            providers,
            by_model,
        }
    }

    pub fn get(&self, name: &str) -> Option<&ProviderDef> {
        self.providers.iter().find(|p| p.name == name)
    }

    /// All providers that list `model`, in registry order, plus wildcard
    /// providers. Empty when nothing claims the model.
    pub fn candidates<'a>(&'a self, model: &str) -> Vec<&'a ProviderDef> {
        let mut out: Vec<&'a ProviderDef> = Vec::new();
        if let Some(idxs) = self.by_model.get(model) {
            for &i in idxs {
                out.push(&self.providers[i]);
            }
        }
        if let Some(wild) = self.by_model.get("") {
            for &i in wild {
                let p = &self.providers[i];
                if !out.iter().any(|q| q.name == p.name) {
                    out.push(p);
                }
            }
        }
        out
    }

    /// Candidates that can actually serve right now.
    pub fn usable_candidates<'a>(&'a self, model: &str) -> Vec<&'a ProviderDef> {
        self.candidates(model)
            .into_iter()
            .filter(|p| p.usable())
            .collect()
    }
}

/// AstMatrix's 13 built-in providers, with their upstream base URLs, key
/// environment variables, model lists, weights, and ELO seeds — exactly as
/// `providers.go` declares them. Key material is never stored here; each
/// entry names the env var AstMatrix resolved.
/// Flock's hand-maintained operational overlay on top of Roost's wire data.
///
/// Roost (`crate::roost_providers`) is the authority for wire fields: base URLs,
/// key env vars, auth schemes, cold-start seeds. This overlay decides WHICH
/// Roost providers flock serves and carries flock's operational tuning:
/// ELO/weight seeds, free-tier flags, model maps, RPM defaults, display
/// names. Values are carried verbatim from the pre-Roost hardcoded defaults;
/// do not retune here — retuning is a deliberate separate change.
struct ProviderOverlay {
    name: &'static str,
    elo: i32,
    weight: f64,
    free_tier: bool,
    default_rpm: usize,
    display_name: &'static str,
    model_map: &'static [(&'static str, &'static str)],
}

/// The 14 providers flock serves, in registry order. `display_name` is the
/// bare provider name (verbatim from the old hardcoded defaults).
const FLOCK_PROVIDER_OVERLAY: &[ProviderOverlay] = &[
    ProviderOverlay {
        name: "openrouter",
        elo: 1500,
        weight: 1.0,
        free_tier: false,
        default_rpm: 0,
        display_name: "openrouter",
        model_map: &[],
    },
    ProviderOverlay {
        name: "nvidia",
        elo: 1550,
        weight: 1.2,
        free_tier: true,
        default_rpm: 0,
        display_name: "nvidia",
        model_map: &[("free", "nvidia/nemotron-3-ultra-550b-a55b")],
    },
    ProviderOverlay {
        name: "groq",
        elo: 1580,
        weight: 1.5,
        free_tier: true,
        default_rpm: 0,
        display_name: "groq",
        model_map: &[],
    },
    ProviderOverlay {
        name: "together",
        elo: 1520,
        weight: 1.0,
        free_tier: false,
        default_rpm: 0,
        display_name: "together",
        model_map: &[],
    },
    ProviderOverlay {
        name: "cerebras",
        elo: 1560,
        weight: 1.3,
        free_tier: true,
        default_rpm: 0,
        display_name: "cerebras",
        model_map: &[],
    },
    ProviderOverlay {
        name: "fireworks",
        elo: 1510,
        weight: 1.0,
        free_tier: false,
        default_rpm: 0,
        display_name: "fireworks",
        model_map: &[],
    },
    ProviderOverlay {
        name: "hyperbolic",
        elo: 1490,
        weight: 1.0,
        free_tier: true,
        default_rpm: 0,
        display_name: "hyperbolic",
        model_map: &[],
    },
    ProviderOverlay {
        name: "github",
        elo: 1500,
        weight: 1.0,
        free_tier: true,
        default_rpm: 0,
        display_name: "github",
        model_map: &[],
    },
    ProviderOverlay {
        name: "mistral",
        elo: 1530,
        weight: 1.0,
        free_tier: false,
        default_rpm: 0,
        display_name: "mistral",
        model_map: &[],
    },
    ProviderOverlay {
        name: "openai",
        elo: 1650,
        weight: 1.0,
        free_tier: false,
        default_rpm: 0,
        display_name: "openai",
        model_map: &[],
    },
    ProviderOverlay {
        name: "perplexity",
        elo: 1480,
        weight: 1.0,
        free_tier: false,
        default_rpm: 0,
        display_name: "perplexity",
        model_map: &[],
    },
    ProviderOverlay {
        name: "siliconflow",
        elo: 1470,
        weight: 1.0,
        free_tier: true,
        default_rpm: 0,
        display_name: "siliconflow",
        model_map: &[],
    },
    ProviderOverlay {
        name: "freeinference",
        elo: 1520,
        weight: 1.2,
        free_tier: true,
        default_rpm: 0,
        display_name: "freeinference",
        model_map: &[],
    },
    ProviderOverlay {
        // EAP Gemini. keypool (:25109) injects the credential and translates
        // OpenAI bodies onto the Interactions API, so the provider itself is
        // keyless (auth: none in the Roost table). Without this overlay entry
        // flock never advertised the provider, so tau could not reach the
        // only project that holds the EAP entitlement.
        name: "google",
        elo: 1600,
        weight: 1.6,
        free_tier: false,
        default_rpm: 0,
        display_name: "google (EAP interactions)",
        model_map: &[],
    },
];

/// Flock's provider registry, built from Roost's wire data merged with the
/// hand-maintained [`FLOCK_PROVIDER_OVERLAY`].
///
/// This is on the live serving path: `config.rs::migrate_v1()` calls it on
/// every boot (the on-disk config is v1 with no providers field), so what
/// this returns is what `:25193` advertises and routes after a restart.
///
/// Roost contract: `seeds` are cold-start data and may name dead IDs — they
/// are filtered through `ROOST_DEAD_IDS` here, at the single construction
/// site, so no consumer ever sees a known-dead ID from this registry.
pub fn default_providers() -> Vec<ProviderDef> {
    use crate::roost_providers as roost;
    let dead: std::collections::HashSet<&str> =
        roost::ROOST_DEAD_IDS.iter().copied().collect();
    let mut v = Vec::with_capacity(FLOCK_PROVIDER_OVERLAY.len());
    for ov in FLOCK_PROVIDER_OVERLAY {
        let t = roost::ROOST_PROVIDERS
            .iter()
            .find(|p| p.name == ov.name)
            .unwrap_or_else(|| panic!("overlay references unknown Roost provider: {}", ov.name));
        assert!(
            !t.router_local,
            "flock overlay must not include router-local Roost provider {}",
            ov.name
        );
        assert!(
            t.enabled,
            "flock overlay includes disabled Roost provider {}",
            ov.name
        );
        let mut keys = vec![ProviderKey {
            key_env: t.key_env.to_string(),
            ..ProviderKey::default()
        }];
        if !t.key_env_alt.is_empty() {
            // Roost's multi-key semantic (e.g. NVIDIA_API_KEYS): the alt var
            // becomes a second key on the same provider.
            keys.push(ProviderKey {
                key_env: t.key_env_alt.to_string(),
                ..ProviderKey::default()
            });
        }
        let no_auth = t.auth == "none";
        v.push(ProviderDef {
            name: t.name.to_string(),
            base_url: t.base_url.to_string(),
            auth: if no_auth {
                AuthScheme::None
            } else {
                AuthScheme::ApiKey
            },
            keys,
            no_auth,
            free_tier: ov.free_tier,
            // A static adapter carries its list in the definition; there is no
            // /models endpoint to discover. Seeding only from `seeds` left such
            // providers advertising zero models, which is why the EAP google
            // route was invisible on :25193.
            models: if t.static_models.is_empty() {
                t.seeds
                    .iter()
                    .filter(|m| !dead.contains(*m))
                    .map(|s| s.to_string())
                    .collect()
            } else {
                t.static_models.iter().map(|s| s.to_string()).collect()
            },
            model_map: ov
                .model_map
                .iter()
                .map(|(k, val)| (k.to_string(), val.to_string()))
                .collect(),
            weight: ov.weight,
            elo: ov.elo,
            default_rpm: ov.default_rpm,
            display_name: ov.display_name.to_string(),
            enabled: true,
            context_lengths: t
                .context_lengths
                .iter()
                .map(|(k, v)| (k.to_string(), *v))
                .collect(),
            ..ProviderDef::default()
        });
    }
    v
}


/// A generation of provider runtimes shared with request handlers.
pub type SharedSet = Arc<ProviderSet>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn models_url_never_doubles_the_v1_segment() {
        // Versioned base URLs (the common Roost shape) must not become
        // /v1/v1/models — that 404 marked providers unhealthy and opened
        // their circuits, starving the router of every upstream.
        assert_eq!(
            models_url("https://api.groq.com/openai/v1"),
            "https://api.groq.com/openai/v1/models"
        );
        assert_eq!(
            models_url("https://api.cerebras.ai/v1"),
            "https://api.cerebras.ai/v1/models"
        );
        // Bare hosts still get the /v1 prefix appended.
        assert_eq!(
            models_url("https://api.mistral.ai"),
            "https://api.mistral.ai/v1/models"
        );
        // Trailing slashes are normalized away, with or without the segment.
        assert_eq!(
            models_url("https://api.mistral.ai/"),
            "https://api.mistral.ai/v1/models"
        );
        assert_eq!(
            models_url("https://api.cerebras.ai/v1/"),
            "https://api.cerebras.ai/v1/models"
        );
    }

    #[test]
    fn upstream_url_never_doubles_the_v1_segment() {
        // The double-/v1 404 surfaced as groq `unknown_url` on the serving
        // path, not just the probe path.
        assert_eq!(
            upstream_url(
                "https://api.groq.com/openai/v1",
                "/v1/chat/completions"
            ),
            "https://api.groq.com/openai/v1/chat/completions"
        );
        // Bare-host bases keep gaining the prefix they need.
        assert_eq!(
            upstream_url("https://api.mistral.ai", "/v1/chat/completions"),
            "https://api.mistral.ai/v1/chat/completions"
        );
        // Query strings survive.
        assert_eq!(
            upstream_url("https://api.groq.com/openai/v1", "/v1/models?limit=5"),
            "https://api.groq.com/openai/v1/models?limit=5"
        );
        // A non-/v1 path must not have the base's /v1 stripped.
        assert_eq!(
            upstream_url("https://api.cerebras.ai/v1", "/embeddings"),
            "https://api.cerebras.ai/v1/embeddings"
        );
        // Missing leading slash is tolerated.
        assert_eq!(
            upstream_url("https://api.groq.com/openai/v1", "v1/chat/completions"),
            "https://api.groq.com/openai/v1/chat/completions"
        );
        // Bare "/v1" is the boundary case, not just "/v1/...".
        assert_eq!(
            upstream_url("https://api.groq.com/openai/v1", "/v1"),
            "https://api.groq.com/openai/v1"
        );
    }

    #[test]
    fn builtin_providers_serve_the_chat_path() {
        // Every built-in provider must resolve /v1/chat/completions without a
        // doubled /v1 — the regression these helpers exist to prevent.
        for def in default_providers() {
            let url = upstream_url(&def.base_url, "/v1/chat/completions");
            assert!(
                !url.contains("/v1/v1/"),
                "provider {} composes a doubled /v1: {url}",
                def.name
            );
        }
    }

    #[test]
    fn builtin_provider_catalog_urls_are_reachable() {
        // Every built-in provider must resolve to a catalog URL without a
        // doubled /v1 — the regression this module exists to prevent.
        for def in default_providers() {
            let url = models_url(&def.base_url);
            assert!(
                !url.contains("/v1/v1/"),
                "provider {} composes a doubled /v1: {url}",
                def.name
            );
            assert!(url.ends_with("/v1/models"), "provider {}: {url}", def.name);
        }
    }

    #[test]
    fn fourteen_builtin_providers() {
        let defs = default_providers();
        assert_eq!(defs.len(), 14);
        let names: Vec<&str> = defs.iter().map(|p| p.name.as_str()).collect();
        for expected in [
            "openrouter",
            "nvidia",
            "groq",
            "together",
            "cerebras",
            "fireworks",
            "hyperbolic",
            "github",
            "mistral",
            "openai",
            "perplexity",
            "siliconflow",
            "google",
            "freeinference",
        ] {
            assert!(names.contains(&expected), "missing {expected}");
        }
    }

    #[test]
    fn key_resolution_prefers_literal_then_env() {
        std::env::set_var("FLOCK_TEST_KEY_ENV_X", "env-secret");
        let k = ProviderKey {
            key: "literal".into(),
            key_env: "FLOCK_TEST_KEY_ENV_X".into(),
            ..ProviderKey::default()
        };
        assert_eq!(resolve_key_material(&k).as_deref(), Some("literal"));
        let k2 = ProviderKey {
            key_env: "FLOCK_TEST_KEY_ENV_X".into(),
            ..ProviderKey::default()
        };
        assert_eq!(resolve_key_material(&k2).as_deref(), Some("env-secret"));
        let k3 = ProviderKey {
            key_env: "FLOCK_TEST_KEY_ENV_MISSING".into(),
            ..ProviderKey::default()
        };
        assert_eq!(resolve_key_material(&k3), None);
        std::env::remove_var("FLOCK_TEST_KEY_ENV_X");
    }

    #[test]
    fn rpm_falls_back_through_provider_default_to_astmatrix_rule() {
        let mut p = ProviderDef {
            free_tier: true,
            ..ProviderDef::default()
        };
        let k = ProviderKey::default();
        assert_eq!(p.rpm_for(&k), 10);
        p.free_tier = false;
        assert_eq!(p.rpm_for(&k), 60);
        p.default_rpm = 120;
        assert_eq!(p.rpm_for(&k), 120);
        let k2 = ProviderKey {
            rpm: 7,
            ..ProviderKey::default()
        };
        assert_eq!(p.rpm_for(&k2), 7);
    }

    #[test]
    fn no_auth_provider_is_usable_without_keys() {
        let p = ProviderDef {
            no_auth: true,
            auth: AuthScheme::None,
            enabled: true,
            ..ProviderDef::default()
        };
        assert!(p.usable());
        let p2 = ProviderDef {
            enabled: true,
            ..ProviderDef::default()
        };
        assert!(!p2.usable());
    }

    #[test]
    fn model_map_rewrites() {
        let p = ProviderDef {
            model_map: [("a".to_string(), "b".to_string())].into(),
            ..ProviderDef::default()
        };
        assert_eq!(p.map_model("a"), "b");
        assert_eq!(p.map_model("c"), "c");
        assert!(p.model_rewritten("a"));
        assert!(!p.model_rewritten("c"));
    }

    #[test]
    fn candidates_index_and_wildcard() {
        let defs = default_providers();
        let set = ProviderSet::new(defs);
        let c: Vec<&str> = set
            .candidates("poolside/laguna-xs-2.1:free")
            .iter()
            .map(|p| p.name.as_str())
            .collect();
        assert_eq!(c, vec!["openrouter"]);
        // No builtin declares "*", so an unlisted model resolves to nobody.
        let c2: Vec<&str> = set
            .candidates("some/unknown-model")
            .iter()
            .map(|p| p.name.as_str())
            .collect();
        assert!(c2.is_empty());
    }

    #[test]
    fn wildcard_claims_everything_when_configured() {
        let mut defs = default_providers();
        defs.iter_mut().find(|p| p.name == "nvidia").unwrap().models = vec!["*".to_string()];
        let set = ProviderSet::new(defs);
        let c: Vec<&str> = set
            .candidates("some/unknown-model")
            .iter()
            .map(|p| p.name.as_str())
            .collect();
        assert_eq!(c, vec!["nvidia"]);
    }

    #[test]
    fn builtin_defaults_match_roost() {
        // Roost-derived expectations: wire fields (base_url, key_env, seeds)
        // come from flock/roost/generated/providers.rs; operational tuning
        // (elo/weight/free_tier) comes from FLOCK_PROVIDER_OVERLAY verbatim.
        use crate::roost_providers as roost;
        let defs = default_providers();
        let by_name = |n: &str| defs.iter().find(|p| p.name == n).unwrap();
        let roost_by_name =
            |n: &str| roost::ROOST_PROVIDERS.iter().find(|p| p.name == n).unwrap();
        let dead: std::collections::HashSet<&str> =
            roost::ROOST_DEAD_IDS.iter().copied().collect();

        // Every overlay entry resolves in Roost, is enabled, and is not
        // router-local.
        for ov in FLOCK_PROVIDER_OVERLAY {
            let t = roost_by_name(ov.name);
            assert!(t.enabled, "{} disabled in Roost", ov.name);
            assert!(!t.router_local, "{} is router-local", ov.name);
        }

        // Wire fields match Roost exactly.
        for ov in FLOCK_PROVIDER_OVERLAY {
            let d = by_name(ov.name);
            let t = roost_by_name(ov.name);
            assert_eq!(d.base_url, t.base_url, "{} base_url", ov.name);
            assert_eq!(d.keys[0].key_env, t.key_env, "{} key_env", ov.name);
            // Seeds are Roost's minus dead IDs (the Roost contract).
            // Static adapters seed from static_models, not seeds — mirror
            // default_providers() exactly.
            let want: Vec<String> = if t.static_models.is_empty() {
                t.seeds
                    .iter()
                    .filter(|m| !dead.contains(*m))
                    .map(|s| s.to_string())
                    .collect()
            } else {
                t.static_models.iter().map(|s| s.to_string()).collect()
            };
            assert_eq!(d.models, want, "{} models", ov.name);
            // No advertised seed is a known-dead ID.
            for m in &d.models {
                assert!(!dead.contains(m.as_str()), "{} serves dead {}", ov.name, m);
            }
            // Operational tuning is verbatim from the overlay.
            assert_eq!(d.elo, ov.elo, "{} elo", ov.name);
            assert_eq!(d.weight, ov.weight, "{} weight", ov.name);
            assert_eq!(d.free_tier, ov.free_tier, "{} free_tier", ov.name);
        }

        // Spot checks on values that changed with the Roost migration.
        let ls = by_name("herd");
        assert!(ls.no_auth);
        assert_eq!(ls.elo, 1600);
        assert_eq!(
            ls.models,
            vec!["local-fast", "local-quality", "local-longctx"]
        );
        let nv = by_name("nvidia");
        assert_eq!(nv.base_url, "https://integrate.api.nvidia.com/v1");
        assert!(nv.free_tier);
        assert_eq!(nv.weight, 1.2);
        assert_eq!(nv.elo, 1550);
        // NVIDIA_API_KEYS alt var becomes a second key.
        assert_eq!(nv.keys.len(), 2);
        assert_eq!(nv.keys[0].key_env, "NVIDIA_API_KEY");
        assert_eq!(nv.keys[1].key_env, "NVIDIA_API_KEYS");
        assert_eq!(
            nv.model_map.get("free").map(|s| s.as_str()),
            Some("nvidia/nemotron-3-ultra-550b-a55b")
        );
        // Roost's nvidia seeds (7, the entitlement-verified working set)
        // replace the 2 stale hardcoded ones.
        assert_eq!(nv.models.len(), 7);
        let mi = by_name("mistral");
        // Roost authority: no /v1 suffix (the old hardcode was wrong).
        assert_eq!(mi.base_url, "https://api.mistral.ai");
        let sf = by_name("siliconflow");
        // Roost authority: .com not .cn.
        assert_eq!(sf.base_url, "https://api.siliconflow.com/v1");
        assert!(sf.free_tier);
        assert_eq!(sf.elo, 1470);
        let gq = by_name("groq");
        assert_eq!(gq.elo, 1580);
        assert_eq!(gq.weight, 1.5);
        // Bare gpt-oss-20b survives; only the :free form is dead.
        assert!(gq.models.contains(&"openai/gpt-oss-20b".to_string()));
        assert!(!gq
            .models
            .iter()
            .any(|m| m == "openai/gpt-oss-20b:free"));
    }

    #[test]
    fn roost_providers_copy_in_sync() {
        // mesh/proxy/flock-proxy/src/roost_providers.rs must be byte-identical to
        // mesh/catalog/generated/providers.rs modulo the Generated-at stamp.
        // Regenerate with: bun ../../../flock/scripts/sync-roost-providers.ts --write
        let generated = include_str!("../../../catalog/generated/providers.rs");
        let copy = include_str!("roost_providers.rs");
        fn normalize(s: &str) -> String {
            s.lines()
                .map(|l| {
                    if l.starts_with("// Generated at:") {
                        "// Generated at: <normalized>"
                    } else {
                        l
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
        assert_eq!(
            normalize(copy),
            normalize(generated),
            "roost_providers.rs drifted from mesh/catalog/generated/providers.rs"
        );
    }

    #[test]
    fn strategy_names_parse() {
        assert_eq!(Strategy::parse("hybrid"), Some(Strategy::Hybrid));
        assert_eq!(Strategy::parse("ast_race"), Some(Strategy::AstRace));
        assert_eq!(
            Strategy::parse("sticky_affinity"),
            Some(Strategy::StickyAffinity)
        );
        assert_eq!(Strategy::parse("weighted_elo"), Some(Strategy::WeightedElo));
        assert_eq!(
            Strategy::parse("least_latency"),
            Some(Strategy::LeastLatency)
        );
        assert_eq!(Strategy::parse("round_robin"), Some(Strategy::RoundRobin));
        assert_eq!(Strategy::parse("free"), Some(Strategy::Free));
        assert_eq!(
            Strategy::parse("circuit_chain"),
            Some(Strategy::CircuitChain)
        );
        assert_eq!(Strategy::parse("bogus"), None);
    }
}
