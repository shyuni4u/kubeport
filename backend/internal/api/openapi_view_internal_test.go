package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"kubeport/internal/auth"
	"kubeport/internal/store"
)

// A failed team lookup must never decide the view in the caller's favour
// (#283). openapiViewFor reports the error alongside the restricted view, and
// proxyOpenAPI turns any error into a 500 before the cache or the cluster is
// touched. The pool points at a closed port, so the query fails without a
// database.
func TestOpenAPIViewFor_LookupErrorIsNotAFullView(t *testing.T) {
	pool, err := pgxpool.New(context.Background(), "postgres://kubeport:kubeport@127.0.0.1:1/none?connect_timeout=1")
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	h := &Handlers{deps: Deps{Store: &store.Store{Queries: store.New(pool)}}}

	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	c.Request = req.WithContext(auth.WithUser(req.Context(), auth.RequestUser{
		Claims: auth.Claims{Subject: "openapi-view-db-down", Email: "someone@example.com"},
	}))

	view, err := h.openapiViewFor(c)
	require.Error(t, err)
	require.Equal(t, openapiViewBuiltin, view)
}
