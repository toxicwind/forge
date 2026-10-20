package server

import (
	"regexp"

	"github.com/mostlygeek/herd/internal/config"
)

// comfyUIIgnorePaths are the path patterns that ComfyUI serves as static
// assets and should not trigger model loading when a GET request hits them.
var comfyUIIgnorePaths = []*regexp.Regexp{
	regexp.MustCompile(config.DefaultUpstreamIgnorePathsPattern),
	regexp.MustCompile(`^/ws(/|$)`),
	regexp.MustCompile(`^/api/jobs$`),
}

// comfyUIIgnoresPath reports whether path should be ignored by the
// ComfyUI handler. Ignored paths are static assets that must not start
// the model.
func comfyUIIgnoresPath(path string) bool {
	for _, re := range comfyUIIgnorePaths {
		if re.MatchString(path) {
			return true
		}
	}
	return false
}
