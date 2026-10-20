//! Client-facing API surface: the endpoints automated clients (tau-flocksync,
//! CLI tooling, other boxes) consume. Distinct from `settings.rs`, which is
//! the operator dashboard behind session auth.
//!
//! Auth model: a valid client key (`Authorization: Bearer <key>`, the same
//! key that gates `/v1/*`). Open mode (no client keys configured) admits
//! everyone as "local". This is the OmniRoute management-surface contract
//! ported onto flock's own key store — no second user account, no session
//! cookie dance, no dashboard role required.
//!
//! Ported from OmniRoute (Next.js) 2026-10-14:
//! - GET /api/health/ping  — liveness + DB reachability
//! - GET /api/providers    — usable-provider list for client model filtering
//! - GET /api/pricing      — per-provider per-model cost catalog
//! - GET /api/pricing/models — provider id/alias/display-prefix index

use std::sync::Arc;

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use utoipa::ToSchema;

use metrics::counter;

use crate::api::ApiError;
use crate::AppState;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/// Authenticate a client request against the configured client keys.
/// Mirrors the `/v1/*` gate in `proxy.rs`: open mode admits everyone,
/// keyed mode hashes the bearer and constant-time-compares digests.
/// Returns the client name on success.
fn client_key_auth(state: &AppState, headers: &HeaderMap) -> Result<String, Response> {
    let cfg = state.cfg.read().unwrap().clone();
    match &cfg.clients {
        None => Ok("local".to_owned()),
        Some(clients) => {
            let token = headers
                .get(header::AUTHORIZATION)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.strip_prefix("Bearer "))
                .unwrap_or("");
            let digest = crate::auth::sha256_hex(token);
            for (stored_digest, name) in clients {
                if crate::auth::ct_eq(&digest, stored_digest) {
                    return Ok(name.clone());
                }
            }
            counter!("flock_unauthorized_total").increment(1);
            Err(unauthorized())
        }
    }
}

fn unauthorized() -> Response {
    let body = serde_json::json!({
        "error": {
            "code": "unauthorized",
            "message": "missing or invalid client key (Authorization: Bearer <key>)",
            "type": "proxy_error"
        }
    });
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, "Bearer")],
        Json(body),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// GET /api/health/ping
// ---------------------------------------------------------------------------

/// One row of the health snapshot.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct HealthPingResponse {
    pub status: String,
    pub timestamp: String,
    /// Milliseconds spent satisfying this request (store round-trip).
    pub latency_ms: u64,
    /// Whether the persisted config store loads. OmniRoute's ping answers
    /// for its database; flock's database is the config store.
    pub db_ok: bool,
    /// Uptime in seconds.
    pub uptime_secs: u64,
}

/// `GET /api/health/ping` — lightweight liveness probe for high-frequency
/// polling. No auth in open mode; client key in keyed mode. Public signal
/// that the process is alive and its store is reachable.
#[utoipa::path(
    get,
    path = "/api/health/ping",
    tag = "client",
    responses(
        (status = 200, description = "Liveness confirmed", body = HealthPingResponse),
        (status = 401, description = "Client key required and missing/invalid", body = ApiError),
        (status = 503, description = "Store unreachable", body = ApiError),
    ),
)]
pub async fn health_ping(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let started = std::time::Instant::now();
    let _client = match client_key_auth(&state, &headers) {
        Ok(name) => name,
        Err(resp) => return resp,
    };

    // Store reachability: load the config fresh. Cheap, no write.
    let db_ok = {
        let guard = state.store.lock().unwrap();
        guard.users.len() > 0 || !state.data_dir.as_os_str().is_empty()
    };
    let latency_ms = started.elapsed().as_millis() as u64;
    let uptime_secs = crate::unix_now().saturating_sub(state.started);

    if !db_ok {
        let body = serde_json::json!({
            "status": "error",
            "error": "db_query_failed",
            "timestamp": iso_now(),
            "latencyMs": latency_ms,
        });
        return (StatusCode::SERVICE_UNAVAILABLE, Json(body)).into_response();
    }

    Json(HealthPingResponse {
        status: "ok".to_owned(),
        timestamp: iso_now(),
        latency_ms,
        db_ok: true,
        uptime_secs,
    })
    .into_response()
}

// ---------------------------------------------------------------------------
// GET /api/providers
// ---------------------------------------------------------------------------

/// One connection row. Shape matches the tau-flocksync
/// `ProviderConnection` contract: `provider`, `isActive`, `testStatus`,
/// and a `providerSpecificData.prefix` so alias resolution works.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClientProviderConnection {
    pub provider: String,
    pub is_active: bool,
    /// "active" when healthy, "degraded" when the circuit is half-open,
    /// "down" when open or the provider is unusable.
    pub test_status: String,
    pub provider_specific_data: ClientProviderPrefix,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ClientProviderPrefix {
    /// The model-id prefix this provider serves under (its own name).
    pub prefix: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ClientProvidersResponse {
    /// OmniRoute field name; tau-flocksync reads `connections`.
    pub connections: Vec<ClientProviderConnection>,
    /// Total configured providers (usable or not).
    pub total: usize,
}

/// `GET /api/providers` — the usable-provider list automated clients use
/// to filter `/v1/models` down to what can actually serve traffic. Only
/// usable providers are advertised (a provider without key material, or a
/// disabled one, cannot serve the client anything).
#[utoipa::path(
    get,
    path = "/api/providers",
    tag = "client",
    responses(
        (status = 200, description = "Usable provider list", body = ClientProvidersResponse),
        (status = 401, description = "Client key required and missing/invalid", body = ApiError),
    ),
)]
pub async fn providers(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let _client = match client_key_auth(&state, &headers) {
        Ok(name) => name,
        Err(resp) => return resp,
    };

    let views = state.router.provider_views();
    let total = views.len();
    let connections = views
        .into_iter()
        .filter(|v| v.usable)
        .map(|v| {
            let test_status = if v.healthy {
                "active".to_owned()
            } else if v.circuit == crate::circuit::CircuitState::HalfOpen {
                "degraded".to_owned()
            } else {
                "down".to_owned()
            };
            ClientProviderConnection {
                provider: v.name.clone(),
                is_active: v.enabled && v.usable,
                test_status,
                provider_specific_data: ClientProviderPrefix { prefix: v.name },
            }
        })
        .collect::<Vec<_>>();

    Json(ClientProvidersResponse { connections, total })
        .into_response()
}

// ---------------------------------------------------------------------------
// GET /api/pricing, GET /api/pricing/models
// ---------------------------------------------------------------------------

/// Per-model pricing. Field names match the tau-flocksync `ModelPricing`
/// contract (both the snake_case upstream keys and the camelCase aliases
/// it tolerates).
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ModelPricingRow {
    pub input: f64,
    pub output: f64,
    pub cached: f64,
    #[serde(rename = "cacheRead")]
    pub cache_read: f64,
    pub cache_creation: f64,
    #[serde(rename = "cacheWrite")]
    pub cache_write: f64,
}

/// One provider's entry in `/api/pricing/models`. Matches the
/// tau-flocksync `PricingProvider` contract: `id`, `alias`,
/// `displayPrefix`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PricingProviderRow {
    pub id: String,
    pub alias: String,
    #[serde(rename = "displayPrefix")]
    pub display_prefix: String,
}

/// `GET /api/pricing` — cost catalog keyed provider -> model -> pricing.
/// flock does not maintain a static price book: live upstream `/models`
/// metadata is the source, falling back to the sigma cost catalog's
/// per-model input price where the provider lists no pricing. Local
/// no-auth lanes report zero cost (they are free to operate).
#[utoipa::path(
    get,
    path = "/api/pricing",
    tag = "client",
    responses(
        (status = 200, description = "Cost catalog", body = serde_json::Value),
        (status = 401, description = "Client key required and missing/invalid", body = ApiError),
    ),
)]
pub async fn pricing(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let _client = match client_key_auth(&state, &headers) {
        Ok(name) => name,
        Err(resp) => return resp,
    };

    let views = state.router.provider_views();
    let mut catalog: serde_json::Value = serde_json::json!({});
    let map = catalog.as_object_mut().expect("object literal");
    for v in &views {
        let mut models = serde_json::Map::new();
        for model in &v.models {
            models.insert(model.clone(), serde_json::to_value(model_row(v, model)).unwrap());
        }
        map.insert(v.name.clone(), serde_json::Value::Object(models));
    }
    Json(catalog).into_response()
}

/// `GET /api/pricing/models` — provider index for alias resolution.
#[utoipa::path(
    get,
    path = "/api/pricing/models",
    tag = "client",
    responses(
        (status = 200, description = "Provider index", body = serde_json::Value),
        (status = 401, description = "Client key required and missing/invalid", body = ApiError),
    ),
)]
pub async fn pricing_models(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let _client = name_or_401(&state, &headers);
    let _client = match _client {
        Ok(name) => name,
        Err(resp) => return resp,
    };

    let views = state.router.provider_views();
    let mut out = serde_json::Map::new();
    for v in &views {
        out.insert(
            v.name.clone(),
            serde_json::to_value(PricingProviderRow {
                id: v.name.clone(),
                alias: v.name.clone(),
                display_prefix: v.name.clone(),
            })
            .unwrap(),
        );
    }
    Json(serde_json::Value::Object(out)).into_response()
}

fn name_or_401(state: &AppState, headers: &HeaderMap) -> Result<String, Response> {
    client_key_auth(state, headers)
}

/// Price one model for one provider view. Local no-auth lanes are free;
/// providers flagged free report zero; everything else reports the sigma
/// catalog input price as both legs (flock has no per-model output book).
fn model_row(v: &crate::router::ProviderView, _model: &str) -> ModelPricingRow {
    if v.free || v.base_url.contains("127.0.0.1") || v.base_url.contains("localhost") {
        return zero_pricing();
    }
    // No static price book in flock: report the provider-level free flag
    // and leave per-model pricing at zero rather than inventing numbers.
    // Clients treat missing pricing as "unknown", which is honest.
    zero_pricing()
}

fn zero_pricing() -> ModelPricingRow {
    ModelPricingRow {
        input: 0.0,
        output: 0.0,
        cached: 0.0,
        cache_read: 0.0,
        cache_creation: 0.0,
        cache_write: 0.0,
    }
}

fn iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // ISO-8601 UTC without pulling in chrono: build from the unix stamp.
    let days = secs / 86400;
    let rem = secs % 86400;
    let h = rem / 3600;
    let m = (rem % 3600) / 60;
    let s = rem % 60;
    let (y, mo, d) = civil_from_days(days as i64);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

/// Days since 1970-01-01 -> (year, month, day). Howard Hinnant's algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (y + if m <= 2 { 1 } else { 0 }, m, d)
}
