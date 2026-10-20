// Package bench: io.go — small file I/O helpers used by the orchestrator.
package bench

import (
	"io"
	"os"
	"path/filepath"
)

// openFileOrDiscard returns a writer to the given path, creating parents as
// needed. If the file can't be created, returns io.Discard so callers
// don't have to special-case it.
func openFileOrDiscard(path string) io.Writer {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return io.Discard
	}
	f, err := os.Create(path)
	if err != nil {
		return io.Discard
	}
	return f
}

// readFileBytes reads a file and returns its bytes, or an error.
func readFileBytes(path string) ([]byte, error) {
	return os.ReadFile(path)
}

// writeFileBytes writes bytes to a path atomically (tmp + rename).
func writeFileBytes(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
