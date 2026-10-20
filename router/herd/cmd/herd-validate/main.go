// Command herd-validate loads herd config through the real loader and reports
// whether it parses and validates.
//
// It exists because the loader used to accept keys it did not understand and
// discard them without a word. A config could name a section that no code
// reads, load cleanly forever, and serve nothing — which is exactly what
// happened to the top-level `aliases:` block in the estate's herd.yaml. The
// loader now rejects unknown top-level keys; this command is how you find
// out, without starting a server.
//
//	herd-validate --config config/herd.yaml
//	herd-validate --config-dir /home/toxic/kimi-auto/herd.d
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/mostlygeek/herd/internal/config"
)

// runValidate loads one config file, or every .yml/.yaml in a directory,
// through config.LoadConfigFromReader and reports the result to out. It
// returns 0 when every config loads, 1 otherwise.
func runValidate(configPath, configDir string, out io.Writer) int {
	targets := []string{}
	if configPath != "" {
		targets = append(targets, configPath)
	} else {
		entries, err := os.ReadDir(configDir)
		if err != nil {
			fmt.Fprintf(out, "failed: %v\n", err)
			return 1
		}
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			name := e.Name()
			if strings.HasSuffix(name, ".yml") || strings.HasSuffix(name, ".yaml") {
				targets = append(targets, filepath.Join(configDir, name))
			}
		}
	}
	if len(targets) == 0 {
		fmt.Fprintln(out, "failed: no config files found")
		return 1
	}
	failed := false
	for _, t := range targets {
		f, err := os.Open(t)
		if err != nil {
			fmt.Fprintf(out, "failed: %s: %v\n", t, err)
			failed = true
			continue
		}
		cfg, err := config.LoadConfigFromReader(f)
		f.Close()
		if err != nil {
			fmt.Fprintf(out, "failed: %s: %v\n", t, err)
			failed = true
			continue
		}
		fmt.Fprintf(out, "ok: %s (%d models, %d macros)\n", t, len(cfg.Models), len(cfg.Macros))
	}
	if failed {
		return 1
	}
	fmt.Fprintln(out, "config is valid")
	return 0
}

func main() {
	configPath := flag.String("config", "", "path to a single config file")
	configDir := flag.String("config-dir", "", "directory of config fragments to validate")
	flag.Parse()

	if *configPath == "" && *configDir == "" {
		fmt.Fprintln(os.Stderr, "usage: herd-validate --config <file> | --config-dir <dir>")
		os.Exit(2)
	}
	if *configPath != "" && *configDir != "" {
		fmt.Fprintln(os.Stderr, "--config and --config-dir are mutually exclusive")
		os.Exit(2)
	}
	os.Exit(runValidate(*configPath, *configDir, os.Stdout))
}