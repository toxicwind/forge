"""Additive ast_race -> flock_race strategy rename in the Go flock package.
Legacy 'ast_race' remains accepted. Safe to re-run."""
import io, os

base = "/home/toxic/estate/ranch/mesh/router/herd/internal/flock"

subs = {
    "router.go": [
        ('case "ast_race":', 'case "ast_race", "flock_race":'),
        ('// Strategy: ast_race (parallel fan-out, first valid wins)',
         '// Strategy: flock_race (parallel fan-out, first valid wins; legacy "ast_race" still accepted)'),
        ('fmt.Errorf("ast_race timeout")', 'fmt.Errorf("flock_race timeout")'),
        ('fmt.Errorf("ast_race all failed: %w", lastErr)',
         'fmt.Errorf("flock_race all failed: %w", lastErr)'),
        ('shared.SendError(w, req, fmt.Errorf("ast_race timeout"))',
         'shared.SendError(w, req, fmt.Errorf("flock_race timeout"))'),
    ],
    "config.go": [
        ('a.ASTStrategy = "ast_race"', 'a.ASTStrategy = "flock_race"'),
    ],
}

for name, pairs in subs.items():
    p = os.path.join(base, name)
    s = io.open(p).read()
    n = 0
    for old, new in pairs:
        if old in s:
            s = s.replace(old, new)
            n += 1
        else:
            print("MISS", name, old[:60])
    io.open(p, "w").write(s)
    print("patched", name, n)

# add flockStrategy yaml alias support via custom UnmarshalYAML if not present
p = os.path.join(base, "config.go")
s = io.open(p).read()
if "flockStrategy" not in s:
    alias = '''
// UnmarshalYAML accepts both the canonical "flockStrategy" key and the
// legacy "astStrategy" key (kept so existing configs keep working).
func (a *FlockConfig) UnmarshalYAML(unmarshal func(interface{}) error) error {
\ttype plain FlockConfig // avoid recursion
\tvar raw map[string]interface{}
\tif err := unmarshal(&raw); err != nil {
\t\treturn err
\t}
\tif v, ok := raw["flockStrategy"]; ok && v != nil {
\t\traw["astStrategy"] = v
\t}
\tif err := unmarshal((*plain)(a)); err != nil {
\t\treturn err
\t}
\treturn nil
}
'''
    io.open(p, "a").write(alias)
    print("added UnmarshalYAML alias")
else:
    print("alias already present")
