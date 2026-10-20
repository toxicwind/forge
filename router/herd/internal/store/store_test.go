package store_test

import (
	"context"
	"github.com/mostlygeek/herd/internal/store"
	"github.com/mostlygeek/herd/internal/store/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"testing"
	"time"
)

func TestStore_Activity_EndToEnd(t *testing.T) {
	ctx := context.Background()
	s, err := sqlite.New("")
	require.NoError(t, err)
	defer s.Close()
	entry, err := s.InsertActivity(ctx, store.ActivityLogEntry{
		Timestamp:       time.Now(),
		Src:             "test-src",
		Model:           "beellama/qwen",
		ReqPath:         "/v1/chat/completions",
		RespContentType: "application/json",
		RespStatusCode:  200,
		Tokens:          store.TokenMetrics{InputTokens: 10, OutputTokens: 20},
		DurationMs:      100,
		HasCapture:      false,
		ErrorMsg:        "",
		Metadata:        map[string]string{},
	})
	require.NoError(t, err)
	assert.Equal(t, "beellama/qwen", entry.Model)
	assert.Equal(t, 200, entry.RespStatusCode)
	page, err := s.ListActivity(ctx, store.ActivityQuery{Limit: 10})
	require.NoError(t, err)
	assert.GreaterOrEqual(t, len(page.Data), 1)
	stats, err := s.ActivityStats(ctx, store.ActivityStatsQuery{Model: "beellama/qwen"})
	require.NoError(t, err)
	assert.GreaterOrEqual(t, stats.TotalRequests, 1)
	err = s.PruneActivity(ctx, 0)
	require.NoError(t, err)
}
