package api

import (
	"context"
	"errors"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
	"kubeport/internal/auth"
	"kubeport/internal/store"
)

type membershipFailureDB struct {
	lookupFailureDB
	membership bool
}

func (db membershipFailureDB) QueryRow(ctx context.Context, query string, args ...interface{}) pgx.Row {
	if db.membership && strings.Contains(query, "GetUserByOidcSubject") {
		return lookupFailureRow{nil}
	}
	return db.lookupFailureDB.QueryRow(ctx, query, args...)
}

func TestTeamMemberLookupFailures(t *testing.T) {
	for _, membership := range []bool{false, true} {
		for _, err := range []error{pgx.ErrNoRows, fmt.Errorf("wrapped: %w", pgx.ErrNoRows), errors.New("private DB failure"), context.Canceled, context.DeadlineExceeded} {
			t.Run(fmt.Sprintf("membership=%v/%v", membership, err), func(t *testing.T) {
				h := &Handlers{deps: Deps{Store: &store.Store{Queries: store.New(membershipFailureDB{lookupFailureDB{err}, membership})}}}
				w := httptest.NewRecorder()
				c, _ := gin.CreateTestContext(w)
				c.Request = httptest.NewRequest("GET", "/", nil)
				c.Request = c.Request.WithContext(auth.WithUser(c.Request.Context(), auth.RequestUser{Claims: auth.Claims{Subject: "test", Email: "test@example.com"}}))
				c.Params = gin.Params{{Key: "id", Value: "6f1c2a4e-9b3d-4c8a-a1e2-3f4b5c6d7e8f"}}
				h.ListTeamMembers(c)
				if errors.Is(err, pgx.ErrNoRows) {
					require.Equal(t, 403, w.Code)
					require.Contains(t, w.Body.String(), `"title":"rbac-denied"`)
				} else {
					require.Equal(t, 500, w.Code)
					require.Contains(t, w.Body.String(), `"title":"internal"`)
					require.NotContains(t, w.Body.String(), err.Error())
				}
			})
		}
	}
}

func TestEndpointQueryAllowLists(t *testing.T) {
	h := &Handlers{deps: Deps{Store: &store.Store{Queries: store.New(lookupFailureDB{errors.New("stop at DB")})}}}
	for _, tc := range []struct {
		name, valid, typo string
		handler           gin.HandlerFunc
	}{
		{"render", "version=3", "versoin=3", h.PreviewRender},
		{"diagnostics", "namespace=prod", "namespaces=prod", h.DiagnoseCluster},
		{"release", "include=storage_on_delete", "includes=storage_on_delete", h.GetRelease},
		{"delete", "force=true", "froce=true", h.DeleteRelease},
		{"logs", "instance=pod-a&since=2026-11-24T00%3A00%3A00Z", "sinse=bad", h.StreamReleaseLogs},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, query := range []string{tc.typo, tc.valid} {
				w := httptest.NewRecorder()
				c, _ := gin.CreateTestContext(w)
				c.Request = httptest.NewRequest("POST", "/?"+query, strings.NewReader(`{"values":{}}`))
				c.Request.Header.Set("Content-Type", "application/json")
				c.Params = gin.Params{{Key: "id", Value: "6f1c2a4e-9b3d-4c8a-a1e2-3f4b5c6d7e8f"}, {Key: "name", Value: "test"}}
				tc.handler(c)
				if query == tc.typo {
					require.Equal(t, 400, w.Code)
					require.Contains(t, w.Body.String(), "unsupported query parameter")
				} else {
					require.NotContains(t, w.Body.String(), "unsupported query parameter")
				}
			}
		})
	}
}
