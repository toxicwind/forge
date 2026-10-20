//! Circuit breaker — AstMatrix's `circuit.go` semantics, native Rust.
//!
//! The port is behavior-faithful: closed allows everything; `max_failures`
//! consecutive failures open the circuit for `timeout`; a half-open trial
//! needs `half_open_max` consecutive successes to close, and a single failure
//! re-opens. Defaults match AstMatrix (5 failures, 30 s timeout) with the
//! GenPark correction of 2 half-open successes (1 is too twitchy, 3 sluggish).
//!
//! GenPark single-probe isolation: while half-open, exactly ONE probe is
//! admitted at a time. Concurrent callers are rejected (fail fast, fail
//! over) until the in-flight probe records its outcome — a recovering
//! provider is never thundering-herded by the whole queue at once.
//!
//! Deliberate correction vs AstMatrix: its race path never consulted the
//! breaker at all, and its hybrid path treated any status below 500 as
//! usable (including 4xx). Here every strategy consults the breaker, and
//! only genuinely retryable failures count — see `MIGRATION.md`.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Persisted circuit snapshot. Wall-clock unix seconds are stored (never
/// `Instant`) so a restart can reconstruct the timeout window.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
pub struct CircuitSnapshot {
    pub state: u8, // 0 closed, 1 half-open, 2 open
    pub failures: u32,
    pub last_failure_unix: u64, // 0 = none
    pub consecutive_successes: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CircuitState {
    Closed,
    HalfOpen,
    Open,
}

pub struct CircuitBreaker {
    state: CircuitState,
    failures: u32,
    last_failure: Option<Instant>,
    last_failure_unix: u64,
    consecutive_successes: u32,
    max_failures: u32,
    timeout: Duration,
    half_open_max: u32,
    /// GenPark single-probe isolation: while half-open, at most one probe
    /// may be in flight. Set by `allow()`, cleared by `record_success`,
    /// `record_failure`, or `release_probe()`.
    probe_inflight: bool,
}

impl CircuitBreaker {
    pub fn new(max_failures: u32, timeout: Duration, half_open_max: u32) -> Self {
        Self {
            state: CircuitState::Closed,
            failures: 0,
            last_failure: None,
            last_failure_unix: 0,
            consecutive_successes: 0,
            max_failures: max_failures.max(1),
            timeout,
            half_open_max: half_open_max.max(1),
            probe_inflight: false,
        }
    }

    /// AstMatrix's defaults: open after 5 failures, 30 s open timeout.
    /// GenPark pattern: 2 consecutive successes close the circuit.
    /// 1 is too twitchy (single lucky success flaps); 3 is sluggish.
    pub fn astmatrix_defaults() -> Self {
        Self::new(5, Duration::from_secs(30), 2)
    }

    pub fn state(&self) -> CircuitState {
        self.state
    }

    pub fn failures(&self) -> u32 {
        self.failures
    }

    /// `Allow` from `circuit.go`, plus GenPark single-probe isolation: closed
    /// always allows; open allows only after the timeout has elapsed
    /// (transitioning to half-open and granting the probe lease to the
    /// transitioner); half-open admits exactly one in-flight probe —
    /// concurrent callers get `false` (fail fast, fail over) until the probe
    /// records its outcome. The comment at the call site in `acquire()`
    /// ("a half-open trial consumes the trial") is now literally true.
    pub fn allow(&mut self) -> bool {
        match self.state {
            CircuitState::Closed => true,
            CircuitState::Open => {
                if let Some(t) = self.last_failure {
                    if t.elapsed() >= self.timeout {
                        self.state = CircuitState::HalfOpen;
                        self.consecutive_successes = 0;
                        self.probe_inflight = true;
                        return true;
                    }
                }
                false
            }
            CircuitState::HalfOpen => {
                if self.probe_inflight {
                    false
                } else {
                    self.probe_inflight = true;
                    true
                }
            }
        }
    }

    /// Release a held probe lease without recording an outcome. The
    /// admission stack calls this when an admitted probe never reaches the
    /// upstream (rate limit, deadline, client gone) so the next half-open
    /// caller can probe instead of failing over against a stuck lease.
    pub fn release_probe(&mut self) {
        self.probe_inflight = false;
    }

    /// `RecordSuccess`: a half-open trial that reaches `half_open_max`
    /// consecutive successes closes the circuit and resets failures.
    /// Releases the probe lease either way.
    pub fn record_success(&mut self) {
        self.probe_inflight = false;
        match self.state {
            CircuitState::Closed => {
                self.failures = 0;
            }
            CircuitState::HalfOpen => {
                self.consecutive_successes += 1;
                if self.consecutive_successes >= self.half_open_max {
                    self.state = CircuitState::Closed;
                    self.failures = 0;
                    self.consecutive_successes = 0;
                }
            }
            CircuitState::Open => {}
        }
    }

    /// `RecordFailure`: increments the failure count; reaching
    /// `max_failures` opens the circuit. A half-open failure re-opens
    /// immediately. Releases the probe lease either way.
    pub fn record_failure(&mut self, now_unix: u64) {
        self.probe_inflight = false;
        match self.state {
            CircuitState::Closed => {
                self.failures += 1;
                if self.failures >= self.max_failures {
                    self.open(now_unix);
                }
            }
            CircuitState::HalfOpen => {
                self.open(now_unix);
            }
            CircuitState::Open => {}
        }
    }

    fn open(&mut self, now_unix: u64) {
        self.state = CircuitState::Open;
        self.last_failure = Some(Instant::now());
        self.last_failure_unix = now_unix;
        self.consecutive_successes = 0;
    }

    /// Force-open for operator intervention (not in AstMatrix; additive).
    pub fn force_open(&mut self, now_unix: u64) {
        self.open(now_unix);
    }

    /// Snapshot for the persistence writer.
    pub fn snapshot(&self) -> CircuitSnapshot {
        CircuitSnapshot {
            state: match self.state {
                CircuitState::Closed => 0,
                CircuitState::HalfOpen => 1,
                CircuitState::Open => 2,
            },
            failures: self.failures,
            last_failure_unix: self.last_failure_unix,
            consecutive_successes: self.consecutive_successes,
        }
    }

    /// Restore from a persisted snapshot. An open circuit whose timeout has
    /// already elapsed while the process was down becomes half-open on the
    /// next `allow()` — same behavior as if the timeout had elapsed live.
    /// No probe survives a restart, so the single-probe lease always
    /// restores clear.
    pub fn restore(snap: CircuitSnapshot, now_unix: u64) -> Self {
        let mut cb = Self::astmatrix_defaults();
        cb.failures = snap.failures;
        cb.consecutive_successes = snap.consecutive_successes;
        cb.last_failure_unix = snap.last_failure_unix;
        cb.probe_inflight = false;
        if snap.last_failure_unix > 0 {
            let age = now_unix.saturating_sub(snap.last_failure_unix);
            cb.last_failure = Some(Instant::now() - Duration::from_secs(age));
        }
        cb.state = match snap.state {
            1 => CircuitState::HalfOpen,
            2 => CircuitState::Open,
            _ => CircuitState::Closed,
        };
        cb
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closed_allows_and_resets_on_success() {
        let mut cb = CircuitBreaker::astmatrix_defaults();
        assert!(cb.allow());
        cb.record_failure(1000);
        cb.record_failure(1000);
        assert_eq!(cb.failures(), 2);
        cb.record_success();
        assert_eq!(cb.failures(), 0);
        assert_eq!(cb.state(), CircuitState::Closed);
    }

    #[test]
    fn five_failures_open_and_timeout_half_opens() {
        let mut cb = CircuitBreaker::new(5, Duration::from_millis(50), 3);
        for _ in 0..5 {
            cb.record_failure(1000);
        }
        assert_eq!(cb.state(), CircuitState::Open);
        assert!(!cb.allow());
        std::thread::sleep(Duration::from_millis(60));
        assert!(cb.allow());
        assert_eq!(cb.state(), CircuitState::HalfOpen);
    }

    #[test]
    fn half_open_needs_three_successes_and_failure_reopens() {
        let mut cb = CircuitBreaker::new(5, Duration::from_millis(10), 3);
        for _ in 0..5 {
            cb.record_failure(1000);
        }
        std::thread::sleep(Duration::from_millis(20));
        assert!(cb.allow()); // -> half-open
        cb.record_success();
        cb.record_success();
        assert_eq!(cb.state(), CircuitState::HalfOpen);
        cb.record_failure(1001); // re-opens immediately
        assert_eq!(cb.state(), CircuitState::Open);
        assert!(!cb.allow());
    }

    #[test]
    fn half_open_three_successes_close() {
        let mut cb = CircuitBreaker::new(5, Duration::from_millis(10), 3);
        for _ in 0..5 {
            cb.record_failure(1000);
        }
        std::thread::sleep(Duration::from_millis(20));
        assert!(cb.allow());
        for _ in 0..3 {
            cb.record_success();
        }
        assert_eq!(cb.state(), CircuitState::Closed);
        assert_eq!(cb.failures(), 0);
    }

    #[test]
    fn half_open_admits_exactly_one_probe() {
        // GenPark single-probe isolation: while a half-open probe is in
        // flight, concurrent callers fail fast instead of thundering-herding
        // the recovering provider.
        let mut cb = CircuitBreaker::new(2, Duration::from_millis(10), 2);
        for _ in 0..2 {
            cb.record_failure(1000);
        }
        assert_eq!(cb.state(), CircuitState::Open);
        std::thread::sleep(Duration::from_millis(20));
        assert!(cb.allow()); // transitioner takes the probe lease
        assert_eq!(cb.state(), CircuitState::HalfOpen);
        assert!(!cb.allow()); // sibling: rejected while probe in flight
        assert!(!cb.allow());
        cb.record_success(); // probe lands: lease released
        assert!(cb.allow()); // next caller may probe
        assert!(!cb.allow()); // ...but only one at a time
    }

    #[test]
    fn release_probe_unsticks_an_abandoned_lease() {
        let mut cb = CircuitBreaker::new(2, Duration::from_millis(10), 2);
        for _ in 0..2 {
            cb.record_failure(1000);
        }
        std::thread::sleep(Duration::from_millis(20));
        assert!(cb.allow());
        assert!(!cb.allow());
        // The probe never reached upstream (rate limit / deadline / client
        // gone): release without an outcome so the next caller can probe.
        cb.release_probe();
        assert!(cb.allow());
        assert_eq!(cb.state(), CircuitState::HalfOpen);
    }

    #[test]
    fn closed_never_holds_a_probe_lease() {
        let mut cb = CircuitBreaker::astmatrix_defaults();
        for _ in 0..10 {
            assert!(cb.allow());
        }
        cb.record_success();
        for _ in 0..10 {
            assert!(cb.allow());
        }
    }

    #[test]
    fn failure_releases_probe_and_reopens() {
        let mut cb = CircuitBreaker::new(2, Duration::from_millis(10), 2);
        for _ in 0..2 {
            cb.record_failure(1000);
        }
        std::thread::sleep(Duration::from_millis(20));
        assert!(cb.allow());
        cb.record_failure(1001); // probe fails: re-opens immediately
        assert_eq!(cb.state(), CircuitState::Open);
        assert!(!cb.allow());
    }

    #[test]
    fn restore_clears_the_probe_lease() {
        let mut cb = CircuitBreaker::new(2, Duration::from_millis(10), 2);
        for _ in 0..2 {
            cb.record_failure(5000);
        }
        let snap = cb.snapshot();
        let mut restored = CircuitBreaker::restore(snap, 5000 + 31);
        assert!(restored.allow()); // half-open, lease to transitioner
        assert!(!restored.allow());
    }

    #[test]
    fn snapshot_restore_round_trip() {
        let mut cb = CircuitBreaker::astmatrix_defaults();
        for _ in 0..5 {
            cb.record_failure(5000);
        }
        let snap = cb.snapshot();
        assert_eq!(snap.state, 2);
        assert_eq!(snap.failures, 5);
        assert_eq!(snap.last_failure_unix, 5000);
        let mut restored = CircuitBreaker::restore(snap, 5000 + 10);
        assert_eq!(restored.state(), CircuitState::Open);
        // 10 s < 30 s timeout: still blocked
        assert!(!restored.allow());
        let mut restored2 = CircuitBreaker::restore(snap, 5000 + 31);
        // timeout elapsed while down: half-opens on next allow
        assert!(restored2.allow());
        assert_eq!(restored2.state(), CircuitState::HalfOpen);
    }

    /// Full persisted recovery sequence with no wall-clock sleeps: the
    /// cooldown elapsing is simulated through `restore()` (the same path a
    /// real restart takes), so the test never blocks on a timer.
    ///
    /// closed --(5 failures)--> open --(30 s cooldown, faked)--> half-open
    /// --(2 trial successes)--> closed.
    #[test]
    fn full_recovery_sequence_no_sleep() {
        let mut cb = CircuitBreaker::astmatrix_defaults();
        assert_eq!(cb.state(), CircuitState::Closed);

        // 1. closed -> open after the failure threshold.
        for _ in 0..5 {
            cb.record_failure(1_000_000);
        }
        assert_eq!(cb.state(), CircuitState::Open);
        assert!(!cb.allow()); // gate shut while the cooldown runs

        // 2. open -> half-open after the cooldown, via the persistence
        // boundary: snapshot, then restore as a restart 31 s later would.
        let snap = cb.snapshot();
        assert_eq!(snap.state, 2);
        assert_eq!(snap.failures, 5);
        assert_eq!(snap.last_failure_unix, 1_000_000);
        let mut cb = CircuitBreaker::restore(snap, 1_000_000 + 31);
        assert_eq!(cb.state(), CircuitState::Open); // still open until consulted
        assert!(cb.allow()); // -> half-open; probe lease goes to the transitioner
        assert_eq!(cb.state(), CircuitState::HalfOpen);
        assert!(!cb.allow()); // concurrent callers fail fast while probing

        // 3. half-open -> closed after `half_open_max` (2) trial successes.
        cb.record_success();
        assert_eq!(cb.state(), CircuitState::HalfOpen);
        assert_eq!(cb.failures(), 5); // failures reset only on close
        cb.record_success();
        assert_eq!(cb.state(), CircuitState::Closed);
        assert_eq!(cb.failures(), 0);
        assert!(cb.allow());
    }

    /// The failing branch of the same sequence, also sleep-free: a failed
    /// half-open probe re-opens immediately with a FRESH cooldown, and the
    /// persisted snapshot carries that new window across a restart.
    #[test]
    fn trial_failure_reopens_with_fresh_cooldown_no_sleep() {
        let mut cb = CircuitBreaker::astmatrix_defaults();
        for _ in 0..5 {
            cb.record_failure(2_000_000);
        }
        assert_eq!(cb.state(), CircuitState::Open);

        // Cooldown faked elapsed -> half-open probe admitted -> probe fails.
        let snap = cb.snapshot();
        let mut cb = CircuitBreaker::restore(snap, 2_000_000 + 31);
        assert!(cb.allow());
        assert_eq!(cb.state(), CircuitState::HalfOpen);
        cb.record_failure(2_000_031);
        assert_eq!(cb.state(), CircuitState::Open);
        assert!(!cb.allow());

        // The re-open stamps a fresh 30 s window: a restart 10 s after the
        // failed probe still blocks, 31 s after it half-opens again.
        let snap = cb.snapshot();
        assert_eq!(snap.state, 2);
        assert_eq!(snap.last_failure_unix, 2_000_031);
        let mut too_soon = CircuitBreaker::restore(snap, 2_000_031 + 10);
        assert_eq!(too_soon.state(), CircuitState::Open);
        assert!(!too_soon.allow());
        let mut cooled = CircuitBreaker::restore(snap, 2_000_031 + 31);
        assert!(cooled.allow());
        assert_eq!(cooled.state(), CircuitState::HalfOpen);
    }
}
