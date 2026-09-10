package api_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/config"
)

func TestHealthz(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{Version: "abc1234"})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
	require.JSONEq(t, `{"status":"ok","version":"abc1234"}`, w.Body.String())
}
