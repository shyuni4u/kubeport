package api_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/auth"
	"kubeport/internal/config"
)

type stubVerifier struct{}

func (stubVerifier) Verify(_ context.Context, _ string) (auth.Claims, error) {
	return auth.Claims{Subject: "stub", Email: "alice@example.com"}, nil
}

// emailVerifier returns a configurable Claims struct so tests can exercise
// the KBP_DEV_ADMIN_EMAILS branch of requireAuth.
type emailVerifier struct {
	claims auth.Claims
}

func (e emailVerifier) Verify(_ context.Context, _ string) (auth.Claims, error) {
	return e.claims, nil
}

func TestAuthMiddleware_Rejects_NoHeader(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: stubVerifier{}, Store: testStore(t)})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/me", nil)
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusUnauthorized, w.Code)
	require.Contains(t, w.Body.String(), "unauthenticated")
}

func TestAuthMiddleware_Accepts_Bearer(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: stubVerifier{}, Store: testStore(t)})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/me", nil)
	req.Header.Set("Authorization", "Bearer anything")
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), "alice@example.com")
}

func TestAuthMiddleware_DevAdminEmails(t *testing.T) {
	cases := []struct {
		name       string
		envVal     string
		claimEmail string
		wantAdmin  bool
	}{
		{"unset does not elevate", "", "admin@example.com", false},
		{"matching email elevates", "admin@example.com", "admin@example.com", true},
		{"non-matching email does not elevate", "admin@example.com", "alice@example.com", false},
		{"case-insensitive match", "Admin@Example.com", "admin@example.com", true},
		{"comma-separated list, match", "root@example.com, admin@example.com", "admin@example.com", true},
		{"comma-separated list, no match", "root@example.com,dba@example.com", "alice@example.com", false},
		{"empty claim email never elevates", "admin@example.com", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("KBP_DEV_ADMIN_EMAILS", tc.envVal)
			v := emailVerifier{claims: auth.Claims{Email: tc.claimEmail}}
			r := api.NewRouter(config.Config{}, api.Deps{Verifier: v, Store: testStore(t)})
			w := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "/v1/me", nil)
			req.Header.Set("Authorization", "Bearer x")
			r.ServeHTTP(w, req)
			require.Equal(t, http.StatusOK, w.Code, w.Body.String())
			if tc.wantAdmin {
				require.Contains(t, w.Body.String(), "kubeport-admin")
			} else {
				require.NotContains(t, w.Body.String(), "kubeport-admin")
			}
		})
	}
}
