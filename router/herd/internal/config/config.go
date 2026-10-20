package config

import (
	"fmt"
	"os"
	"sort"

	"gopkg.in/yaml.v3"
)

const DEFAULT_GROUP_ID = "(default)"
const DEFAULT_UNLOAD_TIMEOUT = 10
const (
	LogToStdoutProxy    = "proxy"
	LogToStdoutUpstream = "upstream"
	LogToStdoutBoth     = "both"
	LogToStdoutNone     = "none"
)

type MacroEntry struct {
	Name  string
	Value any
}

type MacroList []MacroEntry

func (ml *MacroList) UnmarshalYAML(value *yaml.Node) error {
	if value.Kind != yaml.MappingNode {
		return fmt.Errorf("macros must be a mapping")
	}
	entries := make([]MacroEntry, 0, len(value.Content)/2)
	for i := 0; i < len(value.Content); i += 2 {
		keyNode := value.Content[i]
		valueNode := value.Content[i+1]
		var name string
		if err := keyNode.Decode(&name); err != nil {
			return fmt.Errorf("failed to decode macro name: %w", err)
		}
		var val any
		if err := valueNode.Decode(&val); err != nil {
			return fmt.Errorf("failed to decode macro value for '%s': %w", name, err)
		}
		entries = append(entries, MacroEntry{Name: name, Value: val})
	}
	*ml = entries
	return nil
}

// MarshalYAML renders the list back as an ordered mapping, the shape it is
// written in, rather than the default slice-of-structs. Only diagnostics such
// as the config__get_config tool marshal a Config, but when they do the macro
// block should read like the source file.
func (ml MacroList) MarshalYAML() (interface{}, error) {
	node := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	for _, entry := range ml {
		var key, value yaml.Node
		if err := key.Encode(entry.Name); err != nil {
			return nil, fmt.Errorf("encoding macro name %q: %w", entry.Name, err)
		}
		if err := value.Encode(entry.Value); err != nil {
			return nil, fmt.Errorf("encoding macro value for %q: %w", entry.Name, err)
		}
		node.Content = append(node.Content, &key, &value)
	}
	return node, nil
}

// Get retrieves a macro value by name
func (ml MacroList) Get(name string) (any, bool) {
	for _, entry := range ml {
		if entry.Name == name {
			return entry.Value, true
		}
	}
	return nil, false
}

func (ml MacroList) ToMap() map[string]any {
	result := make(map[string]any, len(ml))
	for _, entry := range ml {
		result[entry.Name] = entry.Value
	}
	return result
}

type GroupConfig struct {
	Swap       bool     `yaml:"swap"`
	Exclusive  bool     `yaml:"exclusive"`
	Persistent bool     `yaml:"persistent"`
	Members    []string `yaml:"members"`
}

func (c *GroupConfig) UnmarshalYAML(unmarshal func(interface{}) error) error {
	type rawGroupConfig GroupConfig
	defaults := rawGroupConfig{
		Swap:       true,
		Exclusive:  true,
		Persistent: false,
		Members:    []string{},
	}
	if err := unmarshal(&defaults); err != nil {
		return err
	}
	*c = GroupConfig(defaults)
	return nil
}

type HooksConfig struct {
	OnStartup HookOnStartup `yaml:"on_startup"`
}

type HookOnStartup struct {
	Preload []string `yaml:"preload"`
	Profile string   `yaml:"profile"`
}

type Store struct {
	Path string `yaml:"path"`
}

type UIConfig struct {
	Activity UIActivityConfig `yaml:"activity" json:"activity"`
}

type UIActivityConfig struct {
	SessionID []string `yaml:"session_id" json:"session_id"`
}

// AstMatrixConfig configures the AST Matrix cloud router.
type AstMatrixConfig struct {
	Enabled     bool                   `yaml:"enabled"`
	Strategy    string                 `yaml:"strategy"`
	MaxParallel int                    `yaml:"maxParallel"`
	DbPath      string                 `yaml:"dbPath"`
	StickyTTL   int                    `yaml:"stickyTtl"`
	FifoMax     int                    `yaml:"fifoMax"`
	Providers   map[string]ProviderCfg `yaml:"providers"`
}

// ProviderCfg is per-provider configuration in the AST Matrix.
type ProviderCfg struct {
	BaseURL   string `yaml:"baseUrl"`
	KeyEnv    string `yaml:"keyEnv"`
	KeyEnvAlt string `yaml:"keyEnvAlt"`
	NoAuth    bool   `yaml:"noAuth"`
}

func (a *AstMatrixConfig) Defaults() {
	if a.Strategy == "" {
		a.Strategy = "hybrid"
	}
	if a.MaxParallel <= 0 {
		a.MaxParallel = 4
	}
	if a.DbPath == "" {
		a.DbPath = "/home/toxic/estate/var/data/ast_matrix.db"
	}
	if a.StickyTTL <= 0 {
		a.StickyTTL = 1800
	}
	if a.FifoMax <= 0 {
		a.FifoMax = 64
	}
}

type ProfileConfig struct {
	Description string            `yaml:"description" json:"description"`
	Pins        map[string]string `yaml:"pins" json:"pins"`
}

func (c *ProfileConfig) UnmarshalYAML(value *yaml.Node) error {
	if value.Kind != yaml.MappingNode {
		return fmt.Errorf("profile must be a mapping with description and pins (legacy list syntax is no longer supported)")
	}
	type rawProfileConfig ProfileConfig
	var raw rawProfileConfig
	if err := value.Decode(&raw); err != nil {
		return err
	}
	*c = ProfileConfig(raw)
	return nil
}

type Config struct {
	GlobalConcurrencyLimit int             `yaml:"global_concurrency_limit" json:"global_concurrency_limit"`
	Security               *SecurityConfig `yaml:"security" json:"security"`
	Tailcat                *TailcatConfig  `yaml:"tailcat" json:"tailcat"`
	tailcatEnabled         bool
	HealthCheckTimeout     int                       `yaml:"healthCheckTimeout"`
	LogRequests            bool                      `yaml:"logRequests"`
	LogLevel               string                    `yaml:"logLevel"`
	LogTimeFormat          string                    `yaml:"logTimeFormat"`
	LogToStdout            string                    `yaml:"logToStdout"`
	MetricsMaxInMemory     int                       `yaml:"metricsMaxInMemory"`
	CaptureBuffer          int                       `yaml:"captureBuffer"`
	Store                  *Store                    `yaml:"store"`
	UI                     UIConfig                  `yaml:"ui"`
	Performance            PerformanceConfig         `yaml:"performance"`
	GlobalTTL              int                       `yaml:"globalTTL"`
	UnloadTimeout          int                       `yaml:"unloadTimeout"`
	Models                 map[string]ModelConfig    `yaml:"models"`
	Profiles               map[string]ProfileConfig  `yaml:"profiles"`
	Selectors              map[string]SelectorConfig `yaml:"selectors"`
	aliases                map[string]string
	StartPort              int                  `yaml:"startPort"`
	Hooks                  HooksConfig          `yaml:"hooks"`
	SendLoadingState       bool                 `yaml:"sendLoadingState"`
	IncludeAliasesInList   bool                 `yaml:"includeAliasesInList"`
	RequiredAPIKeys        []string             `yaml:"apiKeys"`
	Peers                  PeerDictionaryConfig `yaml:"peers"`
	Upstream               UpstreamConfig       `yaml:"upstream"`
	// AstMatrix configures the AST Matrix cloud router (estate-scripts extension - autonomous first-class).
	// When enabled, cloud model requests are routed through the matrix to remote providers.
	AstMatrix *AstMatrixConfig `yaml:"astMatrix"`

	// routing is the canonical source for swap/scheduling configuration.
	// New code must read Routing, never the backwards-compat fields below.
	Routing RoutingConfig `yaml:"routing"`

	// Groups and Matrix are permanent backwards-compat input fields for the
	// legacy top-level `groups:`/`matrix:` keys. They are normalized into
	// Routing by LoadConfigFromReader. New code must not read them directly.
	Groups map[string]GroupConfig `yaml:"groups"` /* key is group ID */
	Matrix *MatrixConfig          `yaml:"matrix"`
	Macros MacroList              `yaml:"macros"`
}

type RoutingConfig struct {
	Scheduler SchedulerConfig `yaml:"scheduler"`
	Router    RouterConfig    `yaml:"router"`
}

type SchedulerConfig struct {
	Use      string            `yaml:"use"`
	Settings SchedulerSettings `yaml:"settings"`
}

type SchedulerSettings struct {
	Fifo FifoConfig `yaml:"fifo"`
}

type FifoConfig struct {
	Priority map[string]int `yaml:"priority"`
}

type RouterConfig struct {
	Use      string         `yaml:"use"`
	Settings RouterSettings `yaml:"settings"`
}

type RouterSettings struct {
	Groups map[string]GroupConfig `yaml:"groups"`
	Matrix *MatrixConfig          `yaml:"matrix"`
}

func (c *Config) RealModelName(search string) (string, bool) {
	if _, found := c.Models[search]; found {
		return search, true
	} else if name, found := c.aliases[search]; found {
		return name, found
	} else {
		return "", false
	}
}
func (c *Config) TailcatEnabled() bool {
	return c.tailcatEnabled
}

func (c *Config) SetTailcatEnabled(enabled bool) {
	c.tailcatEnabled = enabled
}

func (c *Config) FindConfig(modelName string) (ModelConfig, string, bool) {
	if realName, found := c.RealModelName(modelName); !found {
		return ModelConfig{}, "", false
	} else {
		return c.Models[realName], realName, true
	}
}

func (c *Config) ResolveBaseModel(search string) (string, bool) {
	if realName, found := c.RealModelName(search); found {
		return realName, true
	}
	if _, _, found := c.ResolvePeerModel(search); found {
		return search, true
	}
	return "", false
}

func LoadConfig(path string) (Config, error) {
	file, err := os.Open(path)
	if err != nil {
		return Config{}, err
	}
	defer file.Close()
	return LoadConfigFromReader(file)
}

func AddDefaultGroupToConfig(config Config) Config {
	if config.Groups == nil {
		config.Groups = make(map[string]GroupConfig)
	}
	defaultGroup := GroupConfig{
		Swap:      true,
		Exclusive: true,
		Members:   []string{},
	}
	if len(config.Groups) == 0 {
		for modelName := range config.Models {
			defaultGroup.Members = append(defaultGroup.Members, modelName)
		}
	} else {
		for modelName := range config.Models {
			foundModel := false
		found:
			for _, groupConfig := range config.Groups {
				for _, member := range groupConfig.Members {
					if member == modelName {
						foundModel = true
						break found
					}
				}
			}
			if !foundModel {
				defaultGroup.Members = append(defaultGroup.Members, modelName)
			}
		}
	}
	sort.Strings(defaultGroup.Members)
	config.Groups[DEFAULT_GROUP_ID] = defaultGroup
	return config
}
