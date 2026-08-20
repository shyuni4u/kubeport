package store_test

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"kubeport/internal/store"
)

func testDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://kubeport:kubeport@localhost:5432/kubeport?sslmode=disable"
	}
	return dsn
}

func pgText(s string) pgtype.Text {
	return pgtype.Text{String: s, Valid: true}
}

func TestUpsertUser(t *testing.T) {
	ctx := context.Background()
	s, err := store.NewStore(ctx, testDSN(t))
	require.NoError(t, err)
	defer s.Close()

	u, err := s.UpsertUser(ctx, store.UpsertUserParams{
		OidcSubject: "test-sub-" + time.Now().Format("150405.000000"),
		Email:       pgText("alice@example.com"),
		DisplayName: pgText("Alice"),
	})
	require.NoError(t, err)
	require.Equal(t, "alice@example.com", u.Email.String)
}

func TestStore_WithTx_RollsBackOnError(t *testing.T) {
	ctx := context.Background()
	s, err := store.NewStore(ctx, testDSN(t))
	require.NoError(t, err)
	defer s.Close()

	stamp := time.Now().Format("150405.000000")
	name := "rollback-" + stamp

	sentinel := errors.New("sentinel rollback trigger")
	err = s.WithTx(ctx, func(q *store.Queries) error {
		_, err := q.InsertCluster(ctx, store.InsertClusterParams{
			Name:          name,
			ApiUrl:        "https://k",
			OidcIssuerUrl: "http://localhost:5556",
		})
		if err != nil {
			return err
		}
		return sentinel
	})
	require.ErrorIs(t, err, sentinel)

	_, err = s.GetClusterByName(ctx, name)
	require.Error(t, err, "cluster must not be committed after rollback")
}

func TestInsertClusterAndTemplate(t *testing.T) {
	ctx := context.Background()
	s, err := store.NewStore(ctx, testDSN(t))
	require.NoError(t, err)
	defer s.Close()

	stamp := time.Now().Format("150405.000000")

	u, err := s.UpsertUser(ctx, store.UpsertUserParams{
		OidcSubject: "owner-" + stamp,
		Email:       pgText("owner@example.com"),
		DisplayName: pgText("Owner"),
	})
	require.NoError(t, err)

	c, err := s.InsertCluster(ctx, store.InsertClusterParams{
		Name:          "test-" + stamp,
		DisplayName:   pgText("Test Cluster"),
		ApiUrl:        "https://kubernetes.default:443",
		OidcIssuerUrl: "http://localhost:5556",
	})
	require.NoError(t, err)
	require.NotZero(t, c.ID)

	tpl, err := s.InsertTemplate(ctx, store.InsertTemplateParams{
		Name:        "web-" + stamp,
		DisplayName: "Web",
		OwnerUserID: u.ID,
	})
	require.NoError(t, err)
	require.NotZero(t, tpl.ID)
}

func TestInsertTeamAndMembership(t *testing.T) {
	ctx := context.Background()
	s, err := store.NewStore(ctx, testDSN(t))
	require.NoError(t, err)
	defer s.Close()

	u, err := s.UpsertUser(ctx, store.UpsertUserParams{
		OidcSubject: "team-owner-" + time.Now().Format("150405.000000"),
		Email:       pgText("owner@example.com"),
		DisplayName: pgText("Owner"),
	})
	require.NoError(t, err)

	team, err := s.InsertTeam(ctx, store.InsertTeamParams{
		Name:        "team-" + time.Now().Format("150405.000000"),
		DisplayName: pgText("Team X"),
	})
	require.NoError(t, err)
	require.NotZero(t, team.ID)

	mem, err := s.InsertTeamMembership(ctx, store.InsertTeamMembershipParams{
		UserID: u.ID,
		TeamID: team.ID,
		Role:   "editor",
	})
	require.NoError(t, err)
	require.Equal(t, "editor", mem.Role)

	members, err := s.ListTeamMembers(ctx, team.ID)
	require.NoError(t, err)
	require.Len(t, members, 1)
	require.Equal(t, "owner@example.com", members[0].Email.String)
}
