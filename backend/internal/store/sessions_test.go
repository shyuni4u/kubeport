package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"kubeport/internal/store"
)

// DeleteExpiredSessions is what keeps the sessions table from growing forever
// with encrypted id/refresh tokens nobody can use any more. It must take the
// expired rows and only those.
func TestDeleteExpiredSessions(t *testing.T) {
	ctx := context.Background()
	s, err := store.NewStore(ctx, testDSN(t))
	require.NoError(t, err)
	defer s.Close()

	stamp := time.Now().Format("150405.000000")
	user, err := s.UpsertUser(ctx, store.UpsertUserParams{
		OidcSubject: "reap-" + stamp,
		Email:       pgText("reap-" + stamp + "@example.com"),
		DisplayName: pgText("Reap"),
	})
	require.NoError(t, err)
	newSession := func(expiresAt time.Time) pgtype.UUID {
		t.Helper()
		row, err := s.CreateSession(ctx, store.CreateSessionParams{
			UserID:                user.ID,
			IDTokenEncrypted:      "enc",
			RefreshTokenEncrypted: pgText("enc"),
			IDTokenExp:            pgtype.Timestamptz{Time: expiresAt, Valid: true},
			ExpiresAt:             pgtype.Timestamptz{Time: expiresAt, Valid: true},
		})
		require.NoError(t, err)
		t.Cleanup(func() { _ = s.DeleteSession(context.Background(), row.ID) })
		return row.ID
	}

	expired1 := newSession(time.Now().Add(-2 * time.Hour))
	expired2 := newSession(time.Now().Add(-1 * time.Minute))
	live := newSession(time.Now().Add(time.Hour))

	// Batch of 1 proves the LIMIT is honoured — a huge backlog must not be
	// deleted in one long-locking statement.
	n, err := s.DeleteExpiredSessions(ctx, 1)
	require.NoError(t, err)
	require.Equal(t, int64(1), n)

	n, err = s.DeleteExpiredSessions(ctx, 100)
	require.NoError(t, err)
	require.GreaterOrEqual(t, n, int64(1), "the second expired row should still be swept")

	// Both expired rows are gone; the live one is untouched and still readable.
	for _, id := range []pgtype.UUID{expired1, expired2} {
		_, err := s.GetSession(ctx, id)
		require.Error(t, err, "expired session should be deleted")
	}
	got, err := s.GetSession(ctx, live)
	require.NoError(t, err, "unexpired session must survive the sweep")
	require.Equal(t, live, got.ID)
}
