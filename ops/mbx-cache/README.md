# mbx-cache

`mbx-cache` is the estate's local remote cache for [mise](https://mise.jdx.dev/)
task artifacts and mr-boxington builds.

- **Daemon:** `mbx-cache`, supervised by pitchfork on `127.0.0.1:25148`
- **Source:** `vendored/mr-boxington-cache`, upstream `jdx/mr-boxington-cache`
  v0.1.1 at `991a586421d1ace4165a3c53b8ef98d08934fce5`
- **Binary:** built directly with `mise exec -- cargo build --release`
- **Data:** `var/runtime/mbx-cache`
- **Client config:** `mise/conf.d/15-remote-cache.toml`

This is intentionally not a fork and not a container. `ranch/` is for estate
projects with their own history; `vendored/` holds upstream source. The service
configuration belongs in `ops/` because it is estate infrastructure.

## Operations

```bash
curl -fsS http://127.0.0.1:25148/v1/status
curl -fsS http://127.0.0.1:25148/v1/capabilities

cd /home/toxic/estate/vendored/mr-boxington-cache
mise exec -- cargo build --release
pitchfork restart mbx-cache
```

Builds remain `mise run <task>` or direct project commands under `mise exec`.
The cache stores and restores declared task outputs; it does not accept arbitrary
host commands or schedule a job queue.