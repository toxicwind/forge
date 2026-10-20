package flock

import "sync"

type Provider struct {
	Name     string
	Type     string
	Endpoint string
	Weight   float64
	ELO      float64
}

type ProviderRegistry struct {
	mu        sync.RWMutex
	providers map[string]*Provider
}

func NewProviderRegistry() *ProviderRegistry {
	return &ProviderRegistry{providers: make(map[string]*Provider)}
}

func (pr *ProviderRegistry) Register(name, serverType, endpoint string, weight float64) {
	pr.mu.Lock()
	defer pr.mu.Unlock()
	pr.providers[name] = &Provider{Name: name, Type: serverType, Endpoint: endpoint, Weight: weight, ELO: 1600}
}

func (pr *ProviderRegistry) Get(name string) (*Provider, bool) {
	pr.mu.RLock()
	defer pr.mu.RUnlock()
	p, ok := pr.providers[name]
	return p, ok
}

func (pr *ProviderRegistry) All() []*Provider {
	pr.mu.RLock()
	defer pr.mu.RUnlock()
	out := make([]*Provider, 0, len(pr.providers))
	for _, p := range pr.providers { out = append(out, p) }
	return out
}
