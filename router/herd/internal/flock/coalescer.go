package flock

import (
	"net/http"
	"sync"
	"time"
)

type PendingRequest struct {
	mu        sync.Mutex
	done      chan struct{}
	response  *http.Response
	err       error
	completed bool
}

func (pr *PendingRequest) Wait() (*http.Response, error) {
	<-pr.done
	pr.mu.Lock()
	defer pr.mu.Unlock()
	return pr.response, pr.err
}

func (pr *PendingRequest) Complete(resp *http.Response, err error) {
	pr.mu.Lock()
	defer pr.mu.Unlock()
	if pr.completed {
		return
	}
	pr.completed = true
	pr.response = resp
	pr.err = err
	close(pr.done)
}

type RequestCoalescer struct {
	mu      sync.RWMutex
	pending map[string]*PendingRequest
	ttl     time.Duration
}

func NewRequestCoalescer(ttl time.Duration) *RequestCoalescer {
	return &RequestCoalescer{pending: make(map[string]*PendingRequest), ttl: ttl}
}

func (rc *RequestCoalescer) Get(key string) *PendingRequest {
	rc.mu.RLock()
	defer rc.mu.RUnlock()
	return rc.pending[key]
}

func (rc *RequestCoalescer) Register(key string) *PendingRequest {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	pr := &PendingRequest{done: make(chan struct{})}
	rc.pending[key] = pr
	go func() {
		time.Sleep(rc.ttl)
		rc.mu.Lock()
		delete(rc.pending, key)
		rc.mu.Unlock()
	}()
	return pr
}
