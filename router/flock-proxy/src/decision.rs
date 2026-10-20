//! Routing decision records — borrowed from AstrLink.
//!
//! Every routing selection produces a `RoutingDecision` explaining WHY a
//! provider was chosen and which providers were skipped (and why).

use std::sync::RwLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Maximum number of skipped providers kept on one decision record.
pub const MAX_ROUTING_SKIPS: usize = 64;

/// Maximum number of per-attempt ledger entries kept on one decision
/// record — bounded like skips so a pathological retry storm can't grow a
/// single record unbounded.
pub const MAX_ROUTING_ATTEMPTS: usize = 64;

/// Why a provider was selected for an attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SelectionReason {
    Priority,
    SessionBinding,
    ResponseAffinity,
    WebsocketConnection,
    Failover,
    ContextDemoted,
}

impl SelectionReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Priority => "priority",
            Self::SessionBinding => "session_binding",
            Self::ResponseAffinity => "response_affinity",
            Self::WebsocketConnection => "websocket_connection",
            Self::Failover => "failover",
            Self::ContextDemoted => "context_demoted",
        }
    }
}

/// Why routing excluded a provider before any attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    Disabled,
    NotConnected,
    RiskPaused,
    ModelNotListed,
    ProtocolUnsupported,
    StreamingUnsupported,
    ConversionUnavailable,
    CircuitOpen,
    RateLimited,
    WebsocketDisabled,
    WebsocketUnsupported,
    ContextTooSmall,
}

impl SkipReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::NotConnected => "not_connected",
            Self::RiskPaused => "risk_paused",
            Self::ModelNotListed => "model_not_listed",
            Self::ProtocolUnsupported => "protocol_unsupported",
            Self::StreamingUnsupported => "streaming_unsupported",
            Self::ConversionUnavailable => "conversion_unavailable",
            Self::CircuitOpen => "circuit_open",
            Self::RateLimited => "rate_limited",
            Self::WebsocketDisabled => "websocket_disabled",
            Self::WebsocketUnsupported => "websocket_unsupported",
            Self::ContextTooSmall => "context_too_small",
        }
    }
}

/// One provider that routing passed over, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoutingSkip {
    pub provider: String,
    pub reason: SkipReason,
}

/// One upstream attempt: which provider was tried, what came back, and how
/// long the attempt took. `status` is the HTTP status, or 0 for a
/// connection-level failure (no response at all). Borrowed from the
/// modelmux/GenPark attempt ledgers: the count alone (`attempts: usize`)
/// can't explain a failover chain, the per-attempt record can.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoutingAttempt {
    pub provider: String,
    pub status: u16,
    pub latency_ms: u64,
}

/// Explains the provider choice of one routing decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoutingDecision {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected: Option<SelectionReason>,
    #[serde(default)]
    pub skipped: Vec<RoutingSkip>,
    /// Per-attempt ledger, in attempt order. Empty on the selection-time
    /// record; populated as the retry loop runs.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attempts: Vec<RoutingAttempt>,
}

impl RoutingDecision {
    pub fn new() -> Self {
        Self { selected: None, skipped: Vec::new(), attempts: Vec::new() }
    }

    pub fn push_skip(&mut self, provider: impl Into<String>, reason: SkipReason) {
        if self.skipped.len() < MAX_ROUTING_SKIPS {
            self.skipped.push(RoutingSkip { provider: provider.into(), reason });
        }
    }

    /// Record one upstream attempt. Bounded at [`MAX_ROUTING_ATTEMPTS`];
    /// overflow attempts are dropped (the count is preserved by the
    /// ledger length, and a storm of retries must not grow the record).
    pub fn push_attempt(
        &mut self,
        provider: impl Into<String>,
        status: u16,
        latency: Duration,
    ) {
        if self.attempts.len() < MAX_ROUTING_ATTEMPTS {
            self.attempts.push(RoutingAttempt {
                provider: provider.into(),
                status,
                latency_ms: latency.as_millis().min(u64::MAX as u128) as u64,
            });
        }
    }

    pub fn select(&mut self, reason: SelectionReason) {
        self.selected = Some(reason);
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.skipped.len() > MAX_ROUTING_SKIPS {
            return Err(format!("skipped must contain at most {} providers", MAX_ROUTING_SKIPS));
        }
        if self.attempts.len() > MAX_ROUTING_ATTEMPTS {
            return Err(format!("attempts must contain at most {} entries", MAX_ROUTING_ATTEMPTS));
        }
        Ok(())
    }
}

impl Default for RoutingDecision {
    fn default() -> Self { Self::new() }
}

/// Drop-guard that emits the completed routing decision — selection, skips,
/// and the per-attempt ledger — as a structured tracing event when the
/// request's routing scope exits, on every path including early returns and
/// panics. The decision lives behind an [`RwLock`] so the retry loop can
/// keep appending attempts while the guard holds a shared reference; the
/// lock (not a `RefCell`) keeps the future `Send` for `tokio::spawn`.
pub struct DecisionEmit<'a> {
    pub decision: &'a RwLock<RoutingDecision>,
    pub model: &'a str,
}

impl Drop for DecisionEmit<'_> {
    fn drop(&mut self) {
        let d = self.decision.read().unwrap();
        tracing::debug!(
            decision = ?*d,
            model = %self.model,
            attempts = d.attempts.len(),
            "routing decision complete"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_are_bounded_at_64() {
        let mut d = RoutingDecision::new();
        for i in 0..100 {
            d.push_skip(format!("p{}", i), SkipReason::Disabled);
        }
        assert_eq!(d.skipped.len(), MAX_ROUTING_SKIPS);
        assert!(d.validate().is_ok());
    }

    #[test]
    fn attempts_are_bounded_at_64() {
        let mut d = RoutingDecision::new();
        for i in 0..100 {
            d.push_attempt(format!("p{}", i % 3), 503, Duration::from_millis(12));
        }
        assert_eq!(d.attempts.len(), MAX_ROUTING_ATTEMPTS);
        assert!(d.validate().is_ok());
        // First attempts win; the storm tail is dropped, not the head.
        assert_eq!(d.attempts[0].provider, "p0");
        assert_eq!(d.attempts[63].provider, "p0");
    }

    #[test]
    fn attempts_record_provider_status_latency() {
        let mut d = RoutingDecision::new();
        d.push_attempt("nvidia", 0, Duration::from_millis(5));
        d.push_attempt("groq", 429, Duration::from_millis(120));
        d.push_attempt("cerebras", 200, Duration::from_secs(2));
        assert_eq!(d.attempts.len(), 3);
        assert_eq!(d.attempts[0].status, 0);
        assert_eq!(d.attempts[1].status, 429);
        assert_eq!(d.attempts[1].latency_ms, 120);
        assert_eq!(d.attempts[2].latency_ms, 2000);
    }

    #[test]
    fn selection_reasons_serialize_snake_case() {
        let mut d = RoutingDecision::new();
        d.select(SelectionReason::SessionBinding);
        d.push_skip("x", SkipReason::CircuitOpen);
        d.push_attempt("y", 503, Duration::from_millis(7));
        let j = serde_json::to_value(&d).unwrap();
        assert_eq!(j["selected"], "session_binding");
        assert_eq!(j["skipped"][0]["reason"], "circuit_open");
        assert_eq!(j["attempts"][0]["provider"], "y");
        assert_eq!(j["attempts"][0]["status"], 503);
        assert_eq!(j["attempts"][0]["latency_ms"], 7);
    }

    #[test]
    fn empty_attempts_omitted_from_json() {
        let d = RoutingDecision::new();
        let j = serde_json::to_value(&d).unwrap();
        assert!(j.get("attempts").is_none());
    }
}
