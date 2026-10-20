package freeproxy

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// GlobalCache is a file-backed cache under $HOME/.cache/freeproxy.
// It persists across builds/restarts and is the default for home/toxic.
// Falls back to memory if HOME/.cache is not writable. Ponytail: no redis, no extra dep.
type globalCache struct {
	mu  sync.Mutex
	dir string
	mem *memoryCache // fallback + fast path
}

func homeCacheDir() string {
	// estate-scripts global cache is /home/toxic/cache (no dot) — see env CACHE_DIR, GOCACHE, etc.
	// Prefer CACHE_DIR, then XDG_CACHE_HOME, then $HOME/cache (estate-scripts), then $HOME/.cache
	if d := os.Getenv("CACHE_DIR"); d != "" {
		return filepath.Join(d, "freeproxy")
	}
	if d := os.Getenv("XDG_CACHE_HOME"); d != "" {
		return filepath.Join(d, "freeproxy")
	}
	home := os.Getenv("HOME")
	if home == "" {
		home = "/home/toxic"
	}
	// estate-scripts uses /home/toxic/cache (no dot) as global cache; keep .cache as fallback
	if _, err := os.Stat(filepath.Join(home, "cache")); err == nil {
		return filepath.Join(home, "cache", "freeproxy")
	}
	return filepath.Join(home, ".cache", "freeproxy")
}

func NewGlobalCache() Cache {
	dir := homeCacheDir()
	_ = os.MkdirAll(dir, 0o755)
	return &globalCache{
		dir: dir,
		mem: &memoryCache{data: make(map[string]cacheEntry)},
	}
}

// NewMemoryCache kept for tests; production uses NewGlobalCache.
func keyToPath(dir, key string) string {
	h := sha256.Sum256([]byte(key))
	return filepath.Join(dir, hex.EncodeToString(h[:])+".cache")
}

func (g *globalCache) Get(key string) ([]byte, bool) {
	// fast memory first
	if v, ok := g.mem.Get(key); ok {
		return v, true
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	path := keyToPath(g.dir, key)
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	// file mtime as TTL: 60s max; stat check
	info, err := os.Stat(path)
	if err != nil || time.Since(info.ModTime()) > 60*time.Second {
		_ = os.Remove(path)
		return nil, false
	}
	// populate mem for next hit
	g.mem.Set(key, b, 60*time.Second)
	return b, true
}

func (g *globalCache) Set(key string, value []byte, ttl time.Duration) {
	g.mem.Set(key, value, ttl)
	g.mu.Lock()
	defer g.mu.Unlock()
	path := keyToPath(g.dir, key)
	_ = os.WriteFile(path, value, 0o644)
}
