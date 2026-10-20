package config

import (
	"fmt"
	"io"
	"net/url"
	"reflect"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

func LoadConfigFromReader(r io.Reader) (Config, error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return Config{}, err
	}
	yamlStr := string(data)

	// Phase 1: Substitute all ${env.VAR} macros at string level
	// This is safe because env values are simple strings without YAML formatting
	yamlStr, err = substituteEnvMacros(yamlStr)
	if err != nil {
		return Config{}, err
	}

	raw, macroConfig, err := resolveConfigMacros(yamlStr)
	if err != nil {
		return Config{}, err
	}

	var node yaml.Node
	if err = node.Encode(raw); err != nil {
		return Config{}, err
	}

	// Decode the resolved values into the full Config with defaults.
	config := Config{
		HealthCheckTimeout: 120,
		StartPort:          5800,
		LogLevel:           "info",
		LogTimeFormat:      "",
		LogToStdout:        LogToStdoutProxy,
		MetricsMaxInMemory: 1000,
		CaptureBuffer:      5,
		GlobalTTL:          0,
		UnloadTimeout:      DEFAULT_UNLOAD_TIMEOUT,
		UI: UIConfig{Activity: UIActivityConfig{SessionID: []string{
			"X-Session-ID",
			"X-Litellm-Session-Id",
		}}},
	}
	// yaml.v3's Node.Decode silently discards any key the target struct does
	// not declare. That is not a cosmetic problem: herd.yaml carried a
	// top-level `aliases:` block for months that parsed cleanly, produced no
	// warning, and was never served by anything. The only yaml:"aliases" tag
	// in the tree is on ModelConfig (models.<id>.aliases), so the block was
	// dropped at every load and the four names in it only resolved because
	// models: re-declared them separately.
	// Strictness is applied to the TOP LEVEL only, by reflecting over the
	// Config struct's yaml tags. A recursive decoder is not usable here:
	// KnownFields(true) also applies inside the legacy `filters.strip_params`
	// anonymous-struct path, which exists precisely to tolerate fields it
	// does not model, and enforcing it there rejects configs that must load.
	if err = rejectUnknownTopLevelKeys(&node); err != nil {
		return Config{}, err
	}
	if err = node.Decode(&config); err != nil {
		return Config{}, err
	}
	config.Macros = macroConfig.Macros
	for modelID, modelConfig := range config.Models {
		modelConfig.Macros = macroConfig.Models[modelID].Macros
		config.Models[modelID] = modelConfig
	}

	if config.HealthCheckTimeout < 15 {
		config.HealthCheckTimeout = 15
	}

	// Apply defaults for performance config when section is missing
	if config.Performance.Every == 0 {
		config.Performance.Every = 5 * time.Second
	}
	if err = config.Performance.Validate(); err != nil {
		return Config{}, fmt.Errorf("performance: %w", err)
	}

	// A missing security block keeps the permissive legacy CORS policy, but
	// callers read cfg.Security unconditionally, so always materialize it.
	// Validation runs on every load: an empty allowedOrigins list or orphan
	// CORS settings are rejected here, not at request time.
	if config.Security == nil {
		config.Security = &SecurityConfig{}
	}
	if err = config.Security.CORS.Validate(); err != nil {
		return Config{}, fmt.Errorf("security.cors: %w", err)
	}

	if config.StartPort < 1 {
		return Config{}, fmt.Errorf("startPort must be greater than 1")
	}

	if config.GlobalTTL < 0 {
		return Config{}, fmt.Errorf("globalTTL must be >= 0")
	}

	if config.UnloadTimeout < 0 {
		return Config{}, fmt.Errorf("unloadTimeout must be >= 0")
	}
	if config.UnloadTimeout == 0 {
		config.UnloadTimeout = DEFAULT_UNLOAD_TIMEOUT
	}

	config.UI.Activity.SessionID = normalizeHeaderNames(config.UI.Activity.SessionID)

	if config.Store != nil {
		if err := validateStorePath(config.Store.Path); err != nil {
			return Config{}, err
		}
	}

	// Apply default for upstream.ignorePaths when not specified. The default
	// matches common static-asset suffixes so they do not trigger a swap.
	if len(config.Upstream.IgnorePaths) == 0 {
		config.Upstream.IgnorePaths = DefaultUpstreamIgnorePaths()
	}

	switch config.LogToStdout {
	case LogToStdoutProxy, LogToStdoutUpstream, LogToStdoutBoth, LogToStdoutNone:
	default:
		return Config{}, fmt.Errorf("logToStdout must be one of: proxy, upstream, both, none")
	}

	// Security defaults and validation. A missing security block still
	// yields a non-nil Security so the zero CORSConfig selects the legacy
	// permissive policy; Validate rejects an explicitly empty
	// allowedOrigins list rather than reading it as "allow everything".
	if config.Security == nil {
		config.Security = &SecurityConfig{}
	}
	if err := config.Security.CORS.Validate(); err != nil {
		return Config{}, fmt.Errorf("security.cors: %w", err)
	}

	// Tailcat allow-list canonicalization and model validation. Like the
	// CORS check above, the validator existed but was never invoked from
	// the load path.
	if err := validateTailcatConfig(&config); err != nil {
		return Config{}, err
	}

	// Populate the aliases map
	config.aliases = make(map[string]string)
	for modelName, modelConfig := range config.Models {
		for _, alias := range modelConfig.Aliases {
			if _, found := config.aliases[alias]; found {
				return Config{}, fmt.Errorf("duplicate alias %s found in model: %s", alias, modelName)
			}
			config.aliases[alias] = modelName
		}
	}

	// Sort model IDs for deterministic validation and normalization.
	modelIds := make([]string, 0, len(config.Models))
	for modelId := range config.Models {
		modelIds = append(modelIds, modelId)
	}
	sort.Strings(modelIds)

	nextPort := config.StartPort
	for _, modelId := range modelIds {
		modelConfig := config.Models[modelId]
		modelConfig.HealthCheckTimeout = config.HealthCheckTimeout
		if modelId == ComfyUIModelID {
			if modelConfig.ConcurrencyLimit < comfyUIConcurrencyLimit {
				modelConfig.ConcurrencyLimit = comfyUIConcurrencyLimit
			}
			modelConfig.Compat.IgnoreWebsockets = true
		}

		// set model TTL to globalTTL it is the default value
		if modelConfig.UnloadAfter == MODEL_CONFIG_DEFAULT_TTL {
			modelConfig.UnloadAfter = config.GlobalTTL
		}

		if modelConfig.UnloadAfter < 0 {
			return Config{}, fmt.Errorf("model %s: invalid TTL value %d", modelId, modelConfig.UnloadAfter)
		}

		// set model unloadTimeout to the global value when left at the default
		if modelConfig.UnloadTimeout < 0 {
			return Config{}, fmt.Errorf("model %s: invalid unloadTimeout value %d", modelId, modelConfig.UnloadTimeout)
		}
		if modelConfig.UnloadTimeout == 0 {
			modelConfig.UnloadTimeout = config.UnloadTimeout
		}

		// Validate model macros
		for _, macro := range modelConfig.Macros {
			if err = validateMacro(macro.Name, macro.Value); err != nil {
				return Config{}, fmt.Errorf("model %s: %s", modelId, err.Error())
			}
		}

		// Build merged macro list: MODEL_ID + global macros + model macros (model overrides global)
		mergedMacros := make(MacroList, 0, len(config.Macros)+len(modelConfig.Macros)+1)
		mergedMacros = append(mergedMacros, MacroEntry{Name: "MODEL_ID", Value: modelId})
		mergedMacros = append(mergedMacros, config.Macros...)

		// Add model macros (override globals with same name)
		for _, entry := range modelConfig.Macros {
			found := false
			for i, existing := range mergedMacros {
				if existing.Name == entry.Name {
					mergedMacros[i] = entry
					found = true
					break
				}
			}
			if !found {
				mergedMacros = append(mergedMacros, entry)
			}
		}

		// Substitute remaining macros in model fields (LIFO order)
		for i := len(mergedMacros) - 1; i >= 0; i-- {
			entry := mergedMacros[i]
			macroSlug := fmt.Sprintf("${%s}", entry.Name)
			macroStr := fmt.Sprintf("%v", entry.Value)

			modelConfig.Cmd = strings.ReplaceAll(modelConfig.Cmd, macroSlug, macroStr)
			modelConfig.CmdStop = strings.ReplaceAll(modelConfig.CmdStop, macroSlug, macroStr)
			modelConfig.Proxy = strings.ReplaceAll(modelConfig.Proxy, macroSlug, macroStr)
			modelConfig.CheckEndpoint = strings.ReplaceAll(modelConfig.CheckEndpoint, macroSlug, macroStr)
			modelConfig.Filters.StripParams = strings.ReplaceAll(modelConfig.Filters.StripParams, macroSlug, macroStr)
			modelConfig.Name = strings.ReplaceAll(modelConfig.Name, macroSlug, macroStr)
			modelConfig.Description = strings.ReplaceAll(modelConfig.Description, macroSlug, macroStr)

			// Substitute macros in Env (string slice)
			for j, envEntry := range modelConfig.Env {
				modelConfig.Env[j] = strings.ReplaceAll(envEntry, macroSlug, macroStr)
			}

			// Substitute macros in SetParamsByID keys and values
			if len(modelConfig.Filters.SetParamsByID) > 0 {
				newSetParamsByID := make(map[string]map[string]any, len(modelConfig.Filters.SetParamsByID))
				for key, paramMap := range modelConfig.Filters.SetParamsByID {
					newKey := strings.ReplaceAll(key, macroSlug, macroStr)
					newValAny := substituteMacroInValue(any(paramMap), entry.Name, entry.Value)
					newParamMap, ok := newValAny.(map[string]any)
					if !ok {
						return Config{}, fmt.Errorf("model %s filters.setParamsByID: unexpected type after macro substitution", modelId)
					}
					newSetParamsByID[newKey] = newParamMap
				}
				modelConfig.Filters.SetParamsByID = newSetParamsByID
			}

			// Substitute in metadata (type-preserving)
			if len(modelConfig.Metadata) > 0 {
				result := substituteMacroInValue(modelConfig.Metadata, entry.Name, entry.Value)
				modelConfig.Metadata = result.(map[string]any)
			}
		}

		// Resolve macros in capabilities (they couldn't be decoded properly
		// during YAML unmarshal because e.g. "${default_ctx}" is not an int).
		if err := modelConfig.Capabilities.Validate(); err != nil {
			return Config{}, fmt.Errorf("model %s: %w", modelId, err)
		}

		// Handle PORT macro - only allocate if cmd uses it
		cmdHasPort := strings.Contains(modelConfig.Cmd, "${PORT}")
		proxyHasPort := strings.Contains(modelConfig.Proxy, "${PORT}")
		if cmdHasPort || proxyHasPort {
			if !cmdHasPort && proxyHasPort {
				return Config{}, fmt.Errorf("model %s: proxy uses ${PORT} but cmd does not - ${PORT} is only available when used in cmd", modelId)
			}

			macroSlug := "${PORT}"
			macroStr := fmt.Sprintf("%v", nextPort)

			modelConfig.Cmd = strings.ReplaceAll(modelConfig.Cmd, macroSlug, macroStr)
			modelConfig.CmdStop = strings.ReplaceAll(modelConfig.CmdStop, macroSlug, macroStr)
			modelConfig.Proxy = strings.ReplaceAll(modelConfig.Proxy, macroSlug, macroStr)
			modelConfig.Name = strings.ReplaceAll(modelConfig.Name, macroSlug, macroStr)
			modelConfig.Description = strings.ReplaceAll(modelConfig.Description, macroSlug, macroStr)

			for j, envEntry := range modelConfig.Env {
				modelConfig.Env[j] = strings.ReplaceAll(envEntry, macroSlug, macroStr)
			}

			if len(modelConfig.Metadata) > 0 {
				result := substituteMacroInValue(modelConfig.Metadata, "PORT", nextPort)
				modelConfig.Metadata = result.(map[string]any)
			}

			nextPort++
		}

		// Validate no unknown macros remain
		fieldMap := map[string]string{
			"cmd":                 modelConfig.Cmd,
			"cmdStop":             modelConfig.CmdStop,
			"proxy":               modelConfig.Proxy,
			"checkEndpoint":       modelConfig.CheckEndpoint,
			"filters.stripParams": modelConfig.Filters.StripParams,
			"name":                modelConfig.Name,
			"description":         modelConfig.Description,
		}

		for fieldName, fieldValue := range fieldMap {
			matches := macroPatternRegex.FindAllStringSubmatch(fieldValue, -1)
			for _, match := range matches {
				macroName := match[1]
				if macroName == "PID" && fieldName == "cmdStop" {
					continue // replaced at runtime
				}
				if macroName == "PORT" || macroName == "MODEL_ID" {
					return Config{}, fmt.Errorf("macro '${%s}' should have been substituted in %s.%s", macroName, modelId, fieldName)
				}
				return Config{}, fmt.Errorf("unknown macro '${%s}' found in %s.%s", macroName, modelId, fieldName)
			}
		}

		for _, envEntry := range modelConfig.Env {
			matches := macroPatternRegex.FindAllStringSubmatch(envEntry, -1)
			for _, match := range matches {
				macroName := match[1]
				if macroName == "PORT" || macroName == "MODEL_ID" {
					return Config{}, fmt.Errorf("macro '${%s}' should have been substituted in %s.env", macroName, modelId)
				}
				return Config{}, fmt.Errorf("unknown macro '${%s}' found in %s.env", macroName, modelId)
			}
		}

		if len(modelConfig.Metadata) > 0 {
		}

		// Validate SetParamsByID keys and values
		for key := range modelConfig.Filters.SetParamsByID {
			if matches := macroPatternRegex.FindAllStringSubmatch(key, -1); len(matches) > 0 {
				return Config{}, fmt.Errorf("unknown macro '${%s}' found in model %s filters.setParamsByID key", matches[0][1], modelId)
			}
		}

		if err := modelConfig.Capabilities.Validate(); err != nil {
			return Config{}, fmt.Errorf("model %s: %w", modelId, err)
		}

		// Auto-register setParamsByID keys as aliases (skip the model's own ID)
		for key := range modelConfig.Filters.SetParamsByID {
			if key == modelId {
				continue
			}
			if _, exists := config.Models[key]; exists {
				return Config{}, fmt.Errorf("model %s filters.setParamsByID: key '%s' conflicts with an existing model ID", modelId, key)
			}
			if existingModel, exists := config.aliases[key]; exists {
				if existingModel != modelId {
					return Config{}, fmt.Errorf("duplicate alias '%s' in model %s filters.setParamsByID, already used by model %s", key, modelId, existingModel)
				}
				continue // already registered as explicit alias for this model
			}
			config.aliases[key] = modelId
			modelConfig.Aliases = append(modelConfig.Aliases, key)
		}

		if _, err := url.Parse(modelConfig.Proxy); err != nil {
			return Config{}, fmt.Errorf("model %s: invalid proxy URL: %w", modelId, err)
		}

		if modelConfig.SendLoadingState == nil {
			v := config.SendLoadingState
			modelConfig.SendLoadingState = &v
		}

		if modelConfig.NormalizeSSE == nil {
			v := config.Upstream.NormalizeSSE
			modelConfig.NormalizeSSE = &v
		}

		config.Models[modelId] = modelConfig
	}

	// Normalize routing config. The legacy top-level `matrix`/`groups` keys and
	// the new `routing.router` block are mutually exclusive: a config may use
	// either style, never both.
	hasTopLevel := config.Matrix != nil || len(config.Groups) > 0
	rtr := config.Routing.Router
	hasRouting := rtr.Use != "" || rtr.Settings.Matrix != nil || len(rtr.Settings.Groups) > 0

	if hasTopLevel && hasRouting {
		return Config{}, fmt.Errorf("config uses both the legacy top-level 'matrix'/'groups' keys and the new 'routing.router' block; please migrate the top-level keys into 'routing.router' and remove them")
	}

	if !hasTopLevel {
		// Both groups and matrix may be defined under routing.router.settings;
		// routing.router.use selects which one is active, so there is no conflict.
		rs := config.Routing.Router.Settings
		switch config.Routing.Router.Use {
		case "matrix":
			if rs.Matrix == nil {
				return Config{}, fmt.Errorf("routing.router.use is 'matrix' but routing.router.settings.matrix is not set")
			}
			config.Matrix = rs.Matrix
		case "group", "":
			config.Groups = rs.Groups
		default:
			return Config{}, fmt.Errorf("routing.router.use: unknown router %q (valid: group, matrix)", config.Routing.Router.Use)
		}
	}

	// groups XOR matrix
	if config.Matrix != nil && len(config.Groups) > 0 {
		return Config{}, fmt.Errorf("config cannot use both 'groups' and 'matrix'")
	}

	if config.Matrix != nil {
		if err := ValidateMatrix(config.Matrix, config.Models); err != nil {
			return Config{}, fmt.Errorf("matrix: %w", err)
		}
	} else {
		config = AddDefaultGroupToConfig(config)

		// Validate group members
		memberUsage := make(map[string]string)
		for groupID, groupConfig := range config.Groups {
			prevSet := make(map[string]bool)
			for _, member := range groupConfig.Members {
				if _, found := prevSet[member]; found {
					return Config{}, fmt.Errorf("duplicate model member %s found in group: %s", member, groupID)
				}
				prevSet[member] = true

				if existingGroup, exists := memberUsage[member]; exists {
					return Config{}, fmt.Errorf("model member %s is used in multiple groups: %s and %s", member, existingGroup, groupID)
				}
				memberUsage[member] = groupID
			}
		}
	}

	// Build the canonical Config.Routing from the effective result. Both legacy
	// and new-style configs converge here. The Matrix pointer is shared so the
	// compiled matrix program stays in one place.
	if config.Matrix != nil {
		config.Routing.Router.Use = "matrix"
	} else {
		config.Routing.Router.Use = "group"
	}
	config.Routing.Router.Settings.Matrix = config.Matrix
	config.Routing.Router.Settings.Groups = config.Groups

	if config.Routing.Scheduler.Use == "" {
		config.Routing.Scheduler.Use = "fifo"
	}
	if config.Routing.Scheduler.Use != "fifo" {
		return Config{}, fmt.Errorf("routing.scheduler.use: unknown scheduler %q (valid: fifo)", config.Routing.Scheduler.Use)
	}
	for modelID := range config.Routing.Scheduler.Settings.Fifo.Priority {
		if _, found := config.RealModelName(modelID); !found {
			return Config{}, fmt.Errorf("routing.scheduler.settings.fifo.priority references unknown model %q", modelID)
		}
	}

	// Clean up hooks preload
	if len(config.Hooks.OnStartup.Preload) > 0 {
		var toPreload []string
		for _, modelID := range config.Hooks.OnStartup.Preload {
			modelID = strings.TrimSpace(modelID)
			if modelID == "" {
				continue
			}
			if real, found := config.RealModelName(modelID); found {
				toPreload = append(toPreload, real)
			}
		}
		config.Hooks.OnStartup.Preload = toPreload
	}

	// Validate API keys (env macros already substituted at string level)
	for i, apikey := range config.RequiredAPIKeys {
		if apikey == "" {
			return Config{}, fmt.Errorf("empty api key found in apiKeys")
		}
		if strings.Contains(apikey, " ") {
			return Config{}, fmt.Errorf("apiKeys[%d]: api key cannot contain spaces", i)
		}
		config.RequiredAPIKeys[i] = apikey
	}

	if err := ValidatePeerNamespace(config); err != nil {
		return Config{}, err
	}

	if err := validateSelectors(config); err != nil {
		return Config{}, err
	}

	if err := validateProfiles(config); err != nil {
		return Config{}, err
	}

	return config, nil
}

func validateProfiles(config Config) error {
	for profileName, profile := range config.Profiles {
		if strings.TrimSpace(profileName) == "" {
			return fmt.Errorf("profiles: profile names cannot be empty")
		}
		if len(profile.Pins) == 0 {
			return fmt.Errorf("profiles.%s.pins must contain at least one entry", profileName)
		}
		for pin, target := range profile.Pins {
			if strings.TrimSpace(pin) == "" {
				return fmt.Errorf("profiles.%s.pins: pin names cannot be empty", profileName)
			}
			if target == "" {
				continue
			}
			if _, found := config.ResolveBaseModel(target); !found {
				if _, found := config.Selectors[target]; found {
					continue
				}
				return fmt.Errorf("profiles.%s.pins.%s references unknown model %q", profileName, pin, target)
			}
		}
	}
	if profile := config.Hooks.OnStartup.Profile; profile != "" {
		if _, found := config.Profiles[profile]; !found {
			return fmt.Errorf("hooks.on_startup.profile references unknown profile %q", profile)
		}
	}
	return nil
}

func normalizeHeaderNames(names []string) []string {
	normalized := make([]string, 0, len(names))
	seen := make(map[string]struct{}, len(names))
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		key := strings.ToLower(name)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		normalized = append(normalized, name)
	}
	return normalized
}

// knownTopLevelKeys returns the set of keys Config declares, read from the
// struct's yaml tags. Keys tagged `yaml:"-"` are decode-inert and are not
// accepted from input.
func knownTopLevelKeys() map[string]struct{} {
	out := make(map[string]struct{})
	t := reflect.TypeOf(Config{})
	for i := 0; i < t.NumField(); i++ {
		tag := t.Field(i).Tag.Get("yaml")
		if tag == "" || tag == "-" {
			continue
		}
		name := strings.Split(tag, ",")[0]
		if name != "" {
			out[name] = struct{}{}
		}
	}
	// `defs` holds YAML anchors that models consume through `<<:` merge keys.
	// The YAML parser resolves those anchors itself and nothing reads the
	// block as Config data, so it has no struct field by design.
	out["defs"] = struct{}{}
	return out
}

// rejectUnknownTopLevelKeys fails the load when the document carries a
// top-level key Config does not declare.
//
// This exists because yaml.v3 drops such keys silently: a config can name
// `aliases:` at the top level, parse without error, and have the block
// discarded at every load — which is how a four-model alias block sat in
// herd.yaml serving nothing for months while its names appeared to work
// because they were declared again under `models:`.
//
// Only the top level is checked on purpose. Strictness at every depth is not
// an option: the legacy `filters.strip_params` path decodes through an
// anonymous struct that must tolerate fields it does not model.
func rejectUnknownTopLevelKeys(node *yaml.Node) error {
	doc := node
	if doc.Kind == yaml.DocumentNode && len(doc.Content) > 0 {
		doc = doc.Content[0]
	}
	if doc.Kind != yaml.MappingNode {
		return nil
	}
	known := knownTopLevelKeys()
	var unknown []string
	for i := 0; i+1 < len(doc.Content); i += 2 {
		key := doc.Content[i].Value
		if _, ok := known[key]; !ok {
			unknown = append(unknown, key)
		}
	}
	if len(unknown) == 0 {
		return nil
	}
	sort.Strings(unknown)
	return fmt.Errorf("unknown top-level config key(s): %s (herd ignores keys it does not know; "+
		"check for a typo, or a feature this build does not support)", strings.Join(unknown, ", "))
}
