package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/config"
	"kubeport/internal/store"
)

// healthCatalogLastSeed reads catalog.last_seed through a fresh router, for
// the same cache reason as healthCatalogCount. Empty when the field is absent.
func healthCatalogLastSeed(t *testing.T, s *store.Store) string {
	t.Helper()
	r := api.NewRouter(config.Config{}, api.Deps{
		Verifier:            adminVerifier{},
		Store:               s,
		DemoEmailDomain:     demoDomain,
		HealthPublicCatalog: true,
	})
	w := do(t, r, http.MethodGet, "/healthz?verbose=1", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	var body struct {
		Catalog struct {
			LastSeed string `json:"last_seed"`
		} `json:"catalog"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	return body.Catalog.LastSeed
}

// backdateTemplate moves a template's created_at so the test can order rows
// without sleeping. Fixed absolute instants rather than now()-relative ones:
// a rerun against a database an earlier run left rows in writes the same
// values again, instead of a newer "oldest" row that loses to the old one.
func backdateTemplate(t *testing.T, name string, at time.Time) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://kubeport:kubeport@localhost:5432/kubeport?sslmode=disable"
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	require.NoError(t, err)
	defer conn.Close(ctx)
	tag, err := conn.Exec(ctx, `UPDATE templates SET created_at = $2 WHERE name = $1`, name, at)
	require.NoError(t, err)
	require.EqualValues(t, 1, tag.RowsAffected(), "template %s", name)
}

// last_seed is what tells a skipped reset apart from a successful one (#148):
// a failed preflight deletes nothing, so the count stays green while the
// catalog quietly ages. A reset deletes every demo-owned template and the seed
// recreates them, so the oldest demo-owned published row is when the catalog
// was last seeded.
//
// Oldest, not newest: anything published after the seed — a demo visitor's
// template where authoring is opted in — would otherwise make a catalog that
// has not been re-seeded in days look fresh. And only rows a visitor can
// deploy count, for the same reason the template count is scoped: an
// operator's template or a draft says nothing about the demo seed.
func TestHealthzCatalog_LastSeedIsTheOldestDemoOwnedPublishedTemplate(t *testing.T) {
	s := testStore(t)
	optedIn := newDemoAdminRouterWithTemplateCreate(t, s)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{
		Verifier: adminVerifier{}, Store: s, DemoEmailDomain: demoDomain,
	})

	seeded := "demo-seeded-" + randSuffix()
	w := do(t, optedIn, http.MethodPost, "/v1/templates", bytes.NewReader(createTemplateBody(seeded)))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	publishV1(t, optedIn, seeded)

	// Published after the seed and left with its real, newer created_at.
	later := "demo-later-" + randSuffix()
	w = do(t, optedIn, http.MethodPost, "/v1/templates", bytes.NewReader(createTemplateBody(later)))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	publishV1(t, optedIn, later)

	draft := "demo-draft-" + randSuffix()
	w = do(t, optedIn, http.MethodPost, "/v1/templates", bytes.NewReader(createTemplateBody(draft)))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())

	operator := seedPublishedTemplate(t, adminRouter)

	seedAt := time.Date(2001, 1, 1, 21, 0, 7, 0, time.UTC)
	backdateTemplate(t, seeded, seedAt)
	backdateTemplate(t, operator, seedAt.AddDate(-1, 0, 0))
	backdateTemplate(t, draft, seedAt.AddDate(-2, 0, 0))

	require.Equal(t, "2001-01-01T21:00:07Z", healthCatalogLastSeed(t, s),
		"last_seed must be the oldest demo-owned published template — not the newest, not an operator's, not a draft")
}
