package astmatrix

// ProviderDef mirrors the 9Router registry structure.
// Preserves provider catalog entries from free_providers for
// completeness. Only providers with non-empty BaseURL and Format "openai"
// are promoted to the routing matrix at init time.
type ProviderDef struct {
	ID       string
	Priority int
	Category string
	NoAuth   bool
	BaseURL  string
	Format   string
	Models   []ModelEntry
}

// ModelEntry is one model under a provider.
type ModelEntry struct {
	ID   string
	Name string
}

// keyEnvOverride maps provider IDs to their API key environment variable names.
var keyEnvOverride = map[string]string{
	"alicode":        "ALICODE_API_KEY",
	"alicode-intl":   "ALICODE_INTL_API_KEY",
	"blackbox":       "BLACKBOX_API_KEY",
	"byteplus":       "BYTEPLUS_API_KEY",
	"cerebras":       "CEREBRAS_API_KEY",
	"chutes":         "CHUTES_API_KEY",
	"cohere":         "COHERE_API_KEY",
	"featherless":    "FEATHERLESS_API_KEY",
	"fireworks":      "FIREWORKS_API_KEY",
	"github":         "GITHUB_TOKEN",
	"groq":           "GROQ_API_KEY",
	"hyperbolic":     "HYPERBOLIC_API_KEY",
	"iflow":          "IFLOW_API_KEY",
	"mimo-free":      "",
	"mistral":        "MISTRAL_API_KEY",
	"nebius":         "NEBIUS_API_KEY",
	"nvidia":         "NVIDIA_API_KEY",
	"openai":         "OPENAI_API_KEY",
	"opencode":       "",
	"opencode-go":    "OPENCODE_API_KEY",
	"openrouter":     "OPENROUTER_API_KEY",
	"perplexity":     "PERPLEXITY_API_KEY",
	"siliconflow":    "SILICONFLOW_API_KEY",
	"together":       "TOGETHER_API_KEY",
	"venice":         "VENICE_API_KEY",
	"volcengine-ark": "VOLCENGINE_API_KEY",
	"xai":            "XAI_API_KEY",
}

// RegistryProviders is the merged provider catalog.
var RegistryProviders = map[string]ProviderDef{
	"alicode": {
		ID: "alicode", Priority: 20, Category: "apikey",
		BaseURL: "https://coding.dashscope.aliyuncs.com/v1", Format: "openai",
		Models: []ModelEntry{{"qwen3.5-plus", "Qwen3.5 Plus"}, {"kimi-k2.5", "Kimi K2.5"}, {"glm-5", "GLM 5"}},
	},
	"alicode-intl": {
		ID: "alicode-intl", Priority: 10, Category: "apikey",
		BaseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", Format: "openai",
		Models: []ModelEntry{{"qwen3.5-plus", "Qwen3.5 Plus"}, {"kimi-k2.5", "Kimi K2.5"}},
	},
	"anthropic": {
		ID: "anthropic", Priority: 30, Category: "apikey",
		BaseURL: "https://api.anthropic.com/v1", Format: "claude",
		Models: []ModelEntry{{"claude-sonnet-4-20250514", "Claude Sonnet 4"}},
	},
	"blackbox": {
		ID: "blackbox", Priority: 50, Category: "apikey",
		BaseURL: "https://api.blackbox.ai/v1", Format: "openai",
		Models: []ModelEntry{{"claude-fable-5", "Claude Fable 5"}, {"gpt-5.5", "GPT-5.5"}},
	},
	"byteplus": {
		ID: "byteplus", Priority: 70, Category: "freeTier",
		BaseURL: "https://ark.ap-southeast.bytepluses.com/api/coding/v3", Format: "openai",
		Models: []ModelEntry{{"seed-2-0-pro-260328", "Seed 2.0 Pro"}},
	},
	"cerebras": {
		ID: "cerebras", Priority: 60, Category: "apikey",
		BaseURL: "https://api.cerebras.ai/v1", Format: "openai",
		Models: []ModelEntry{{"llama-3.3-70b", "Llama 3.3 70B"}},
	},
	"chutes": {
		ID: "chutes", Priority: 70, Category: "apikey",
		BaseURL: "https://llm.chutes.ai/v1", Format: "openai",
		Models: []ModelEntry{},
	},
	"cohere": {
		ID: "cohere", Priority: 90, Category: "apikey",
		BaseURL: "https://api.cohere.ai/v1", Format: "openai",
		Models: []ModelEntry{{"command-r-plus-08-2024", "Command R+"}},
	},
	"featherless": {
		ID: "featherless", Priority: 65, Category: "apikey",
		BaseURL: "https://api.featherless.ai/v1", Format: "openai",
		Models: []ModelEntry{{"deepseek-ai/DeepSeek-V4-Pro", "DeepSeek V4 Pro"}},
	},
	"fireworks": {
		ID: "fireworks", Priority: 50, Category: "apikey",
		BaseURL: "https://api.fireworks.ai/inference/v1", Format: "openai",
		Models: []ModelEntry{{"accounts/fireworks/models/deepseek-v3p1", "DeepSeek V3.1"}},
	},
	"github": {
		ID: "github", Priority: 40, Category: "oauth",
		BaseURL: "https://api.githubcopilot.com", Format: "openai",
		Models: []ModelEntry{{"gpt-5.2", "GPT-5.2"}, {"claude-sonnet-4.6", "Claude Sonnet 4.6"}},
	},
	"groq": {
		ID: "groq", Priority: 60, Category: "apikey",
		BaseURL: "https://api.groq.com/openai/v1", Format: "openai",
		Models: []ModelEntry{{"llama-3.3-70b-versatile", "Llama 3.3 70B"}},
	},
	"hyperbolic": {
		ID: "hyperbolic", Priority: 160, Category: "apikey",
		BaseURL: "https://api.hyperbolic.xyz/v1", Format: "openai",
		Models: []ModelEntry{{"Qwen/QwQ-32B", "QwQ 32B"}},
	},
	"iflow": {
		ID: "iflow", Priority: 110, Category: "oauth",
		BaseURL: "https://apis.iflow.cn/v1", Format: "openai",
		Models: []ModelEntry{{"qwen3-coder-plus", "Qwen3 Coder Plus"}},
	},
	"mimo-free": {
		ID: "mimo-free", Priority: 50, Category: "free", NoAuth: true,
		BaseURL: "https://api.xiaomimimo.com/api/free-ai/openai", Format: "openai",
		Models: []ModelEntry{{"mimo-auto", "MiMo Auto"}},
	},
	"mistral": {
		ID: "mistral", Priority: 80, Category: "apikey",
		BaseURL: "https://api.mistral.ai/v1", Format: "openai",
		Models: []ModelEntry{{"mistral-large-latest", "Mistral Large 3"}, {"codestral-latest", "Codestral"}},
	},
	"nebius": {
		ID: "nebius", Priority: 70, Category: "apikey",
		BaseURL: "https://api.studio.nebius.ai/v1", Format: "openai",
		Models: []ModelEntry{{"meta-llama/Llama-3.3-70B-Instruct", "Llama 3.3 70B"}},
	},
	"nvidia": {
		ID: "nvidia", Priority: 20, Category: "freeTier",
		BaseURL: "https://integrate.api.nvidia.com/v1", Format: "openai",
		Models: []ModelEntry{{"nvidia/nemotron-3-super-120b-a12b", "Nemotron 3 Super"}, {"deepseek-ai/deepseek-v4-pro", "DeepSeek V4 Pro"}},
	},
	"openai": {
		ID: "openai", Priority: 30, Category: "apikey",
		BaseURL: "https://api.openai.com/v1", Format: "openai",
		Models: []ModelEntry{{"gpt-5.4", "GPT-5.4"}, {"o3", "O3"}, {"o4-mini", "O4 Mini"}},
	},
	"opencode": {
		ID: "opencode", Priority: 40, Category: "free", NoAuth: true,
		BaseURL: "https://opencode.ai", Format: "openai",
		Models: []ModelEntry{},
	},
	"opencode-go": {
		ID: "opencode-go", Priority: 210, Category: "apikey",
		BaseURL: "https://opencode.ai/zen/go/v1", Format: "openai",
		Models: []ModelEntry{{"glm-5.2", "GLM 5.2"}, {"kimi-k2.7-code", "Kimi K2.7 Code"}},
	},
	"openrouter": {
		ID: "openrouter", Priority: 10, Category: "freeTier",
		BaseURL: "https://openrouter.ai/api/v1", Format: "openai",
		Models: []ModelEntry{{"tencent/hy3:free", "Hy3 Free"}, {"poolside/laguna-m.1:free", "Laguna M.1 Free"}, {"qwen/qwen3-coder:free", "Qwen3 Coder Free"}, {"meta-llama/llama-3.3-70b-instruct:free", "Llama 3.3 70B Free"}},
	},
	"perplexity": {
		ID: "perplexity", Priority: 180, Category: "apikey",
		BaseURL: "https://api.perplexity.ai", Format: "openai",
		Models: []ModelEntry{{"sonar-pro", "Sonar Pro"}},
	},
	"siliconflow": {
		ID: "siliconflow", Priority: 250, Category: "apikey",
		BaseURL: "https://api.siliconflow.com/v1", Format: "openai",
		Models: []ModelEntry{{"deepseek-ai/DeepSeek-V4-Pro", "DeepSeek V4 Pro"}},
	},
	"together": {
		ID: "together", Priority: 60, Category: "apikey",
		BaseURL: "https://api.together.xyz/v1", Format: "openai",
		Models: []ModelEntry{{"meta-llama/Llama-3.3-70B-Instruct-Turbo", "Llama 3.3 70B Turbo"}},
	},
	"venice": {
		ID: "venice", Priority: 115, Category: "apikey",
		BaseURL: "https://api.venice.ai/api/v1", Format: "openai",
		Models: []ModelEntry{{"llama-3.3-70b", "Llama 3.3 70B"}},
	},
	"volcengine-ark": {
		ID: "volcengine-ark", Priority: 270, Category: "apikey",
		BaseURL: "https://ark.cn-beijing.volces.com/api/coding/v3", Format: "openai",
		Models: []ModelEntry{{"DeepSeek-V4-Flash", "DeepSeek V4 Flash"}},
	},
	"xai": {
		ID: "xai", Priority: 280, Category: "oauth",
		BaseURL: "https://api.x.ai/v1", Format: "openai",
		Models: []ModelEntry{{"grok-4", "Grok 4"}, {"grok-3", "Grok 3"}},
	},
}

// keyEnvFor returns the environment variable name for the given provider ID.
func keyEnvFor(id string) string {
	if v, ok := keyEnvOverride[id]; ok {
		return v
	}
	upper := ""
	for _, c := range id {
		if c == '-' {
			upper += "_"
		} else if c >= 'a' && c <= 'z' {
			upper += string(rune(c - 32))
		} else {
			upper += string(c)
		}
	}
	return upper + "_API_KEY"
}
