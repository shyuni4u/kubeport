package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"kubeport/internal/api"
	"kubeport/internal/config"
	"kubeport/internal/store"
)

func TestClusterRegistrationRejectsInvalidAddressAndNames(t *testing.T) {
	t.Setenv("KBP_DEV_ALLOW_INSECURE_CLUSTERS", "false")
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: testStore(t)})
	for _, change := range []map[string]string{{"api_url": "http://example.com"}, {"api_url": "https://user:pass@example.com"}, {"name": "Bad/name"}, {"default_namespace": "Bad Namespace"}, {"default_namespace": "a.b"}} {
		payload := map[string]string{"name": "valid", "api_url": "https://example.com", "oidc_issuer_url": "https://issuer.example.com", "ca_bundle": testCAPEM()}
		for k, v := range change {
			payload[k] = v
		}
		body, err := json.Marshal(payload)
		require.NoError(t, err)
		w := do(t, r, http.MethodPost, "/v1/clusters", bytes.NewReader(body))
		require.Equal(t, 400, w.Code, w.Body.String())
	}
}

func TestMissingResourceContracts(t *testing.T) {
	s := testStore(t)
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	for _, tc := range []struct {
		method, path string
		status       int
	}{
		{"GET", "/v1/teams?mine=true", 400},
		{"POST", "/v1/clusters/missing-" + randSuffix() + "/openapi/refresh", 404},
		{"DELETE", "/v1/teams/" + uuid.NewString() + "/members/" + uuid.NewString(), 404},
	} {
		w := do(t, r, tc.method, tc.path, nil)
		require.Equal(t, tc.status, w.Code, w.Body.String())
	}
	team, err := s.InsertTeam(context.Background(), store.InsertTeamParams{Name: "contract-" + randSuffix()})
	require.NoError(t, err)
	w := do(t, r, "DELETE", "/v1/teams/"+uuid.UUID(team.ID.Bytes).String()+"/members/"+uuid.NewString(), nil)
	require.Equal(t, 204, w.Code, w.Body.String())
}
