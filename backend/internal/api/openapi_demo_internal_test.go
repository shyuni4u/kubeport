package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// A real apiserver index has many more entries (these are from a k3s 1.36
// /openapi/v3), including CRDs a demo visitor has no business enumerating.
const sampleOpenAPIIndex = `{
  "paths": {
    "api": {"serverRelativeURL": "/openapi/v3/api?hash=A"},
    "api/v1": {"serverRelativeURL": "/openapi/v3/api/v1?hash=B"},
    "apis": {"serverRelativeURL": "/openapi/v3/apis?hash=C"},
    "apis/apps/v1": {"serverRelativeURL": "/openapi/v3/apis/apps/v1?hash=D"},
    "apis/batch/v1": {"serverRelativeURL": "/openapi/v3/apis/batch/v1?hash=E"},
    "apis/authorization.k8s.io/v1": {"serverRelativeURL": "/openapi/v3/apis/authorization.k8s.io/v1?hash=F"},
    "apis/rbac.authorization.k8s.io/v1": {"serverRelativeURL": "/openapi/v3/apis/rbac.authorization.k8s.io/v1?hash=G"},
    "apis/traefik.io/v1alpha1": {"serverRelativeURL": "/openapi/v3/apis/traefik.io/v1alpha1?hash=H"},
    "apis/cert-manager.io/v1": {"serverRelativeURL": "/openapi/v3/apis/cert-manager.io/v1?hash=I"},
    "version": {"serverRelativeURL": "/openapi/v3/version?hash=J"}
  },
  "extra": "kept"
}`

func TestFilterOpenAPIIndexForDemo_KeepsOnlyDemoGroupVersions(t *testing.T) {
	out, err := filterOpenAPIIndexForDemo([]byte(sampleOpenAPIIndex))
	require.NoError(t, err)

	var doc struct {
		Paths map[string]struct {
			ServerRelativeURL string `json:"serverRelativeURL"`
		} `json:"paths"`
		Extra string `json:"extra"`
	}
	require.NoError(t, json.Unmarshal(out, &doc))

	keys := make([]string, 0, len(doc.Paths))
	for k := range doc.Paths {
		keys = append(keys, k)
	}
	require.ElementsMatch(t, []string{"api/v1", "apis/apps/v1", "apis/batch/v1", "apis/authorization.k8s.io/v1"}, keys)
	// Kept entries are untouched — the frontend follows serverRelativeURL's hash.
	require.Equal(t, "/openapi/v3/apis/apps/v1?hash=D", doc.Paths["apis/apps/v1"].ServerRelativeURL)
	require.Equal(t, "kept", doc.Extra)
	require.NotContains(t, string(out), "traefik.io")
	require.NotContains(t, string(out), "cert-manager.io")
	require.NotContains(t, string(out), "rbac.authorization.k8s.io")
}

func TestFilterOpenAPIIndexForDemo_RefusesWhatIsNotAnIndex(t *testing.T) {
	for _, body := range []string{`not json`, `{"openapi":"3.0.0"}`, `{"paths":[]}`, `[]`} {
		_, err := filterOpenAPIIndexForDemo([]byte(body))
		require.Error(t, err, body)
	}
}

func TestIndexPathGroupVersion(t *testing.T) {
	for p, want := range map[string]string{
		"api/v1":                       "v1",
		"apis/apps/v1":                 "apps/v1",
		"apis/authorization.k8s.io/v1": "authorization.k8s.io/v1",
	} {
		got, ok := indexPathGroupVersion(p)
		require.True(t, ok, p)
		require.Equal(t, want, got, p)
	}
	for _, p := range []string{"api", "apis", "version", "apis/apps", "apis/apps/v1/extra"} {
		_, ok := indexPathGroupVersion(p)
		require.False(t, ok, p)
	}
}

// The allowlist mirrors the demo RBAC. If demo-rbac.yaml grants a new API
// group, a demo account could deploy that kind but the editor would not
// autocomplete it — fail here so the two move together.
func TestDemoOpenAPIGroupVersions_CoverDemoRBAC(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "deploy", "helm", "kubeport", "templates", "demo-rbac.yaml"))
	require.NoError(t, err)

	groups := map[string]bool{}
	for _, m := range regexp.MustCompile(`apiGroups:\s*\[([^\]]*)\]`).FindAllStringSubmatch(string(raw), -1) {
		for _, g := range strings.Split(m[1], ",") {
			groups[strings.Trim(strings.TrimSpace(g), `"'`)] = true
		}
	}
	require.NotEmpty(t, groups, "no apiGroups parsed from demo-rbac.yaml")

	for g := range groups {
		gv := "v1"
		if g != "" {
			gv = g + "/v1"
		}
		require.True(t, demoAllowsGroupVersion(gv), "demo-rbac.yaml grants %q but the demo OpenAPI allowlist has no %q", g, gv)
	}
}
