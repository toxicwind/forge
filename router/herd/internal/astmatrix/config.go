package astmatrix

// AstMatrixConfig configures the AST Matrix router.
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
