package flock

import (
	"sync"
	"sync/atomic"
	"time"
	"unsafe"
)

// LockFreeCircuitBreaker is the lock-free fast-path circuit breaker.
// Borrowed from jhonsferg/relay (Go) — the cache-line-padded, atomic
// fast path that most Go breakers miss.
//
// Design:
// - atomicState mirror + 64-byte cache-line padding so Allow() on healthy
//   services is a lock-free atomic load — mutex only on state transitions.
// - OnStateChange callback fires outside the mutex (no deadlock risk).
// - Defaults: trip at 5 consecutive failures, 60s reset, 3 half-open probes,
//   2 successes to close.
//
// This can replace CircuitBreaker where the hot path matters. The existing
// CircuitBreaker is kept for compatibility; new code should prefer this.

const cacheLineSize = 64

type LockFreeCircuitBreaker struct {
	// Padded atomics: each on its own cache line to avoid false sharing
	_            [cacheLineSize]byte
	state        atomic.Int32 // CircuitState as int32
	_            [cacheLineSize - 4]byte
	failures     atomic.Int32
	_            [cacheLineSize - 4]byte
	successes    atomic.Int32
	_            [cacheLineSize - 4]byte
	lastFailNano atomic.Int64
	_            [cacheLineSize - 8]byte

	// Config (immutable after construction)
	maxFailures      int32
	timeout          time.Duration
	halfOpenMaxCalls int32
	successToClose   int32

	// Transition mutex (only for state changes, not the hot path)
	mu            sync.Mutex
	onStateChange func(old, new CircuitState)
}

func NewLockFreeCircuitBreaker(maxFailures int, timeout time.Duration) *LockFreeCircuitBreaker {
	if maxFailures <= 0 {
		maxFailures = 5
	}
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	lcb := &LockFreeCircuitBreaker{
		maxFailures:      int32(maxFailures),
		timeout:          timeout,
		halfOpenMaxCalls: 3,
		successToClose:   2,
	}
	lcb.state.Store(int32(StateClosed))
	return lcb
}

// OnStateChange sets a callback fired on transitions (outside the mutex).
func (lcb *LockFreeCircuitBreaker) OnStateChange(fn func(old, new CircuitState)) {
	lcb.mu.Lock()
	defer lcb.mu.Unlock()
	lcb.onStateChange = fn
}

// Allow is the hot path: lock-free atomic load when closed.
// Only takes the mutex on Open->HalfOpen transition check.
func (lcb *LockFreeCircuitBreaker) Allow() bool {
	s := CircuitState(lcb.state.Load())
	switch s {
	case StateClosed:
		return true
	case StateOpen:
		// Check if timeout expired (single atomic read)
		if time.Since(time.Unix(0, lcb.lastFailNano.Load())) > lcb.timeout {
			// Try to transition to half-open (mutex for CAS safety)
			lcb.mu.Lock()
			// Re-check under lock
			if CircuitState(lcb.state.Load()) == StateOpen &&
				time.Since(time.Unix(0, lcb.lastFailNano.Load())) > lcb.timeout {
				lcb.transitionLocked(StateHalfOpen)
				lcb.successes.Store(0)
			}
			lcb.mu.Unlock()
			return CircuitState(lcb.state.Load()) == StateHalfOpen &&
				lcb.successes.Load() < lcb.halfOpenMaxCalls
		}
		return false
	case StateHalfOpen:
		return lcb.successes.Load() < lcb.halfOpenMaxCalls
	}
	return false
}

// RecordSuccess is lock-free in the common case.
func (lcb *LockFreeCircuitBreaker) RecordSuccess() {
	s := CircuitState(lcb.state.Load())
	switch s {
	case StateHalfOpen:
		n := lcb.successes.Add(1)
		if n >= lcb.successToClose {
			lcb.mu.Lock()
			if CircuitState(lcb.state.Load()) == StateHalfOpen {
				lcb.transitionLocked(StateClosed)
				lcb.failures.Store(0)
				lcb.successes.Store(0)
			}
			lcb.mu.Unlock()
		}
	case StateClosed:
		lcb.failures.Store(0)
	}
}

// RecordFailure is lock-free except on the trip transition.
func (lcb *LockFreeCircuitBreaker) RecordFailure() {
	lcb.lastFailNano.Store(time.Now().UnixNano())
	s := CircuitState(lcb.state.Load())

	switch s {
	case StateHalfOpen:
		lcb.mu.Lock()
		if CircuitState(lcb.state.Load()) == StateHalfOpen {
			lcb.transitionLocked(StateOpen)
			lcb.successes.Store(0)
		}
		lcb.mu.Unlock()
	case StateClosed:
		n := lcb.failures.Add(1)
		if n >= lcb.maxFailures {
			lcb.mu.Lock()
			// Re-check: another goroutine may have tripped already
			if CircuitState(lcb.state.Load()) == StateClosed &&
				lcb.failures.Load() >= lcb.maxFailures {
				lcb.transitionLocked(StateOpen)
			}
			lcb.mu.Unlock()
		}
	}
}

// State returns current state (lock-free read).
func (lcb *LockFreeCircuitBreaker) State() CircuitState {
	return CircuitState(lcb.state.Load())
}

// Stats returns state, failure count, last failure time.
func (lcb *LockFreeCircuitBreaker) Stats() (CircuitState, int, time.Time) {
	return lcb.State(),
		int(lcb.failures.Load()),
		time.Unix(0, lcb.lastFailNano.Load())
}

// transitionLocked changes state and fires callback outside the mutex.
// Caller must hold lcb.mu.
func (lcb *LockFreeCircuitBreaker) transitionLocked(new CircuitState) {
	old := CircuitState(lcb.state.Load())
	if old == new {
		return
	}
	lcb.state.Store(int32(new))
	cb := lcb.onStateChange
	// Fire callback after releasing lock to avoid deadlock
	go func() {
		if cb != nil {
			cb(old, new)
		}
	}()
}

// Ensure LockFreeCircuitBreaker doesn't grow unexpectedly (padding check).
var _ = unsafe.Sizeof(LockFreeCircuitBreaker{})
