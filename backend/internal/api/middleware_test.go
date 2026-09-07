package api_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
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

type demoVerifier struct{ email string }

func (d demoVerifier) Verify(_ context.Context, _ string) (auth.Claims, error) {
	return auth.Claims{Subject: "demo-" + d.email, Email: d.email, Groups: []string{"kubeport-admin"}}, nil
}

func TestDenyDemo_BlocksRestrictedRoutes(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{
		Verifier: demoVerifier{email: "demo-admin@demo.kubeport"}, Store: testStore(t), DemoEmailDomain: "demo.kubeport",
	})
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/v1/clusters"},
		{http.MethodPost, "/v1/teams"},
		{http.MethodPost, "/v1/teams/00000000-0000-0000-0000-000000000000/members"},
		{http.MethodDelete, "/v1/teams/00000000-0000-0000-0000-000000000000/members/00000000-0000-0000-0000-000000000000"},
		{http.MethodDelete, "/v1/releases/00000000-0000-0000-0000-000000000000?force=true"},
	} {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(tc.method, tc.path, strings.NewReader("{}"))
		req.Header.Set("Authorization", "Bearer x")
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(w, req)
		require.Equal(t, http.StatusForbidden, w.Code, "%s %s: %s", tc.method, tc.path, w.Body.String())
		require.Contains(t, w.Body.String(), "demo-restricted")
	}
}

func TestDenyDemo_AllowsNormalRoutesAndNonDemoUsers(t *testing.T) {
	// demo user hitting an unrestricted route
	r := api.NewRouter(config.Config{}, api.Deps{
		Verifier: demoVerifier{email: "demo-user@demo.kubeport"}, Store: testStore(t), DemoEmailDomain: "demo.kubeport",
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/me", nil)
	req.Header.Set("Authorization", "Bearer x")
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)

	// non-demo admin hitting a restricted route is NOT blocked by denyDemo
	// (may fail later on validation — we only assert it is not 403 demo-restricted)
	r2 := api.NewRouter(config.Config{}, api.Deps{
		Verifier: demoVerifier{email: "root@example.com"}, Store: testStore(t), DemoEmailDomain: "demo.kubeport",
	})
	w2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodPost, "/v1/clusters", strings.NewReader("{}"))
	req2.Header.Set("Authorization", "Bearer x")
	req2.Header.Set("Content-Type", "application/json")
	r2.ServeHTTP(w2, req2)
	require.NotContains(t, w2.Body.String(), "demo-restricted")
}
