package api

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"sigs.k8s.io/yaml"
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

// inlineTemplate matches a Helm expression inside a line, e.g.
// `namespace: {{ .Values.demo.namespace }}`, which YAML would read as a map key.
var inlineTemplate = regexp.MustCompile(`\{\{[^}]*\}\}`)

// demoRBACGroups reads every rules[].apiGroups entry of the Roles in the demo
// RBAC chart template. Whole-line template directives are dropped, inline ones
// become a placeholder string, and each document is parsed as YAML — so flow
// (`[a, b]`) and block (`- a`) lists read alike, where a regex over the text
// would silently skip a block-style rule.
func demoRBACGroups(t *testing.T) (groups map[string]bool, entries int) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "deploy", "helm", "kubeport", "templates", "demo-rbac.yaml"))
	require.NoError(t, err)

	var cleaned bytes.Buffer
	sc := bufio.NewScanner(bytes.NewReader(raw))
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(strings.TrimSpace(line), "{{") {
			continue
		}
		// Inline values (names, labels, namespaces) are never inside rules, so
		// replacing them does not change what is read below.
		// Unquoted: an expression is often joined to more text
		// (`name: {{ include ... }}-demo-admin`), and `"tmpl"-demo-admin` is not
		// valid YAML while `tmpl-demo-admin` is.
		cleaned.WriteString(inlineTemplate.ReplaceAllString(line, "tmpl"))
		cleaned.WriteByte('\n')
	}
	require.NoError(t, sc.Err())

	groups = map[string]bool{}
	for _, docText := range strings.Split(cleaned.String(), "\n---") {
		if strings.TrimSpace(docText) == "" {
			continue
		}
		var doc struct {
			Kind  string `json:"kind"`
			Rules []struct {
				APIGroups []string `json:"apiGroups"`
			} `json:"rules"`
		}
		if err := yaml.Unmarshal([]byte(docText), &doc); err != nil {
			t.Fatalf("a demo-rbac.yaml document does not parse once template expressions are removed: %v\n%s", err, docText)
		}
		if doc.Kind != "Role" && doc.Kind != "ClusterRole" {
			continue
		}
		for _, r := range doc.Rules {
			for _, g := range r.APIGroups {
				groups[g] = true
				entries++
			}
		}
	}
	return groups, entries
}

// The allowlist mirrors the demo RBAC in both directions. RBAC ⊆ allowlist: a
// group a demo account can deploy must autocomplete in the editor. allowlist ⊆
// RBAC: a wider allowlist would show demo visitors groups they cannot use,
// which is the disclosure #124 closed.
func TestDemoOpenAPIGroupVersions_MatchDemoRBAC(t *testing.T) {
	groups, entries := demoRBACGroups(t)
	require.NotZero(t, entries, "no rules[].apiGroups read from demo-rbac.yaml")

	for g := range groups {
		gv := "v1"
		if g != "" {
			gv = g + "/v1"
		}
		require.True(t, demoAllowsGroupVersion(gv),
			"demo-rbac.yaml grants %q but the demo OpenAPI allowlist has no %q (a group served only at another version needs its real version listed)", g, gv)
	}
	for gv := range demoOpenAPIGroupVersions {
		g := ""
		if i := strings.LastIndex(gv, "/"); i >= 0 {
			g = gv[:i]
		}
		require.True(t, groups[g], "the demo OpenAPI allowlist has %q but demo-rbac.yaml grants no group %q", gv, g)
	}
}
