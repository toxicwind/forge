# flock runbook

## Daemon

- pitchfork daemon: `flock` (renamed from `nim-proxy`)
- Listens: `127.0.0.1:8000` · health: `GET /health`
- Binary: `/home/toxic/.flock/flock`
- Data: `/home/toxic/.flock-data` (history store; copied from the old
  `.nim-proxy-data` at rename time — the old dir is left in place, additive)

## Commands

```sh
pitchfork status flock
pitchfork restart flock
curl -s http://127.0.0.1:8000/health
```

## Rebuild

```sh
cargo build --release --manifest-path /home/toxic/projects/flock/proxy/Cargo.toml
cp target/release/flock /home/toxic/.flock/flock
pitchfork restart flock
```

## Notes

- Port stays `:8000` across the rename — router configs needed no changes.
- Old binary at `/home/toxic/.nim-proxy/nim-proxy` is superseded but left in place
  untouched (additive); the `nim-proxy` pitchfork stanza is retired.
