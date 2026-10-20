package main

import (
	"log"
	"os"
	"os/exec"
	"strings"
)

func loadPortsEnv() map[string]string {
	m := map[string]string{}
	for _, p := range []string{"../../config/ports.env", "/home/toxic/estate/config/ports.env", "config/ports.env"} {
		if b, err := os.ReadFile(p); err == nil {
			for _, line := range strings.Split(string(b), "\n") {
				line = strings.TrimSpace(line)
				if line == "" || strings.HasPrefix(line, "#") {
					continue
				}
				if i := strings.Index(line, "="); i > 0 {
					k := strings.TrimSpace(line[:i])
					v := strings.Trim(strings.TrimSpace(line[i+1:]), "\"'")
					m[k] = v
					if os.Getenv(k) == "" {
						os.Setenv(k, v)
					}
				}
			}
			break
		}
	}
	return m
}

func main() {
	loadPortsEnv()
	c := exec.Command("go", append([]string{"run"}, os.Args[1:]...)...)
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	if err := c.Run(); err != nil {
		log.Fatalf("herd launcher failed: %v", err)
	}
}
