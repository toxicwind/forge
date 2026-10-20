// Package store defines the data access contracts for herd.
package store

import (
	"context"
)

// Store is the root data access interface owning the database lifecycle.
type Store interface {
	Activity() ActivityRepository
	Cache() CacheRepository
	IsInMemory() bool
	ListActivity(ctx context.Context, query ActivityQuery) (ActivityPage, error)
	ActivityStats(ctx context.Context, query ActivityStatsQuery) (ActivityStats, error)
	InsertActivity(ctx context.Context, entry ActivityLogEntry) (ActivityLogEntry, error)
	PruneActivity(ctx context.Context, maxRows int) error
	Close() error
}

// ActivityRepository manages activity log persistence.
type ActivityRepository interface {
	Insert(ctx context.Context, entry ActivityLogEntry) (ActivityLogEntry, error)
	List(ctx context.Context, query ActivityQuery) (ActivityPage, error)
	Stats(ctx context.Context, query ActivityStatsQuery) (ActivityStats, error)
	Prune(ctx context.Context, maxRows int) error
}
