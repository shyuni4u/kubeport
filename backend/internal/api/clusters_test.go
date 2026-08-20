package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/auth"
	"kubeport/internal/config"
	"kubeport/internal/store"
)

type adminVerifier struct{}

func (adminVerifier) Verify(_ context.Context, _ string) (auth.Claims, error) {
	return auth.Claims{Subject: "admin", Email: "admin@example.com", Groups: []string{"kubeport-admin"}}, nil
}

func testStore(t *testing.T) *store.Store {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://kubeport:kubeport@localhost:5432/kubeport?sslmode=disable"
	}
	s, err := store.NewStore(context.Background(), dsn)
	require.NoError(t, err)
	t.Cleanup(s.Close)
	return s
}

func randSuffix() string {
	return time.Now().Format("150405.000000")
}

func TestClusters_Register_RequiresAdmin(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: stubVerifier{}, Store: testStore(t)})
	body := bytes.NewReader([]byte(`{"name":"dev-` + randSuffix() + `","api_url":"https://k","oidc_issuer_url":"http://localhost:5556"}`))
	req := httptest.NewRequest(http.MethodPost, "/v1/clusters", body)
	req.Header.Set("Authorization", "Bearer x")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusForbidden, w.Code)
}

func TestClusters_Register_AdminSucceeds(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: testStore(t)})
	body := bytes.NewReader([]byte(`{"name":"dev-` + randSuffix() + `","api_url":"https://k","oidc_issuer_url":"http://localhost:5556"}`))
	req := httptest.NewRequest(http.MethodPost, "/v1/clusters", body)
	req.Header.Set("Authorization", "Bearer x")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusCreated, w.Code)

	var got map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	require.NotEmpty(t, got["id"])
}

func TestClusters_Register_DuplicateReturns409(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: testStore(t)})
	name := "dup-" + randSuffix()
	bodyStr := `{"name":"` + name + `","api_url":"https://k","oidc_issuer_url":"http://localhost:5556"}`

	req1 := httptest.NewRequest(http.MethodPost, "/v1/clusters", bytes.NewReader([]byte(bodyStr)))
	req1.Header.Set("Authorization", "Bearer x")
	req1.Header.Set("Content-Type", "application/json")
	w1 := httptest.NewRecorder()
	r.ServeHTTP(w1, req1)
	require.Equal(t, http.StatusCreated, w1.Code)

	req2 := httptest.NewRequest(http.MethodPost, "/v1/clusters", bytes.NewReader([]byte(bodyStr)))
	req2.Header.Set("Authorization", "Bearer x")
	req2.Header.Set("Content-Type", "application/json")
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req2)
	require.Equal(t, http.StatusConflict, w2.Code)
	require.Contains(t, w2.Body.String(), "conflict")
}
