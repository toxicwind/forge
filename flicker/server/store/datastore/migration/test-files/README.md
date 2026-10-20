# test-files

## sqlite.db

The `sqlite.db` fixture is a pre-dedupe Woodpecker database used by
`TestMigrate` and `TestMigrateRemovesDuplicateLogEntries`. It is
gitignored (`*.db`) and must be regenerated when the migration list changes.

### Regenerating

The fixture is the schema as it was BEFORE the `deduplicate-log-entries`
migration, plus:

- a non-empty legacy `migrations` table (so `Migrate` skips `InitSchema`
  and actually runs the pending migrations), and
- one `log_entries` row with `(step_id=2, line=0)` — the row
  `TestMigrateRemovesDuplicateLogEntries` duplicates before migrating.

The `log_entries` table is created WITHOUT the `UNIQUE(step_id, line)`
index: that index is what the dedupe migration clears the way for, and the
final model sync creates it.

Regenerate with (from `flicker/`):

```bash
# 1. Ensure migration.MigrationTasks() and migration.SyncLogEntryForFixture()
#    exist in server/store/datastore/migration/migration.go
# 2. Write a small main program (see below), run it, delete it.
```

Generator sketch (`gen_fixture.go`, run with `go run`, then delete):

```go
package main

import (
    "fmt"
    "os"

    "go.woodpecker-ci.org/woodpecker/v3/server/store/datastore/migration"
    "src.techknowlogick.com/xormigrate"
    "xorm.io/xorm"
    _ "github.com/mattn/go-sqlite3"
)

func main() {
    out := "server/store/datastore/migration/test-files/sqlite.db"
    os.Remove(out)
    engine, _ := xorm.NewEngine("sqlite3", out)

    var filtered []*xormigrate.Migration
    for _, m := range migration.MigrationTasks() {
        if m.ID == "deduplicate-log-entries" {
            break
        }
        filtered = append(filtered, m)
    }
    m := xormigrate.New(engine, filtered)
    m.InitSchema(func(_ *xorm.Engine) error { return nil })
    if err := m.Migrate(); err != nil {
        panic(err)
    }
    if err := migration.SyncLogEntryForFixture(engine); err != nil {
        panic(err)
    }
    engine.Exec("CREATE TABLE IF NOT EXISTS migrations (name TEXT UNIQUE)")
    engine.Exec("INSERT OR IGNORE INTO migrations (name) VALUES ('legacy-baseline')")
    engine.Exec(
        "INSERT INTO log_entries (step_id, time, line, data, created, type) VALUES (?,?,?,?,?,?)",
        2, 0, 0, []byte("original"), 1641630525, 0,
    )
    engine.Close()
    fmt.Println("fixture written to", out)
}
```

## postgres.sql

Postgres dump used by the same tests when `WOODPECKER_DATABASE_DRIVER=postgres`.
