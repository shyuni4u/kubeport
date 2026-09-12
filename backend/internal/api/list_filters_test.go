package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// Issue #74. The list endpoints ignored every query parameter they did not
// read, so `GET /v1/releases?namespace=prod` answered 200 with every release —
// and the design doc still promised the filters. They are implemented now, and
// a parameter an endpoint does not take is a 400 instead of silence.

func listNames(t *testing.T, r http.Handler, path, key, marker string) []string {
	t.Helper()
	w := do(t, r, http.MethodGet, path, nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var body map[string][]map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	var names []string
	for _, row := range body[key] {
		if name, _ := row["name"].(string); strings.Contains(name, marker) {
			names = append(names, name)
		}
	}
	slices.Sort(names)
	return names
}

func TestListTemplates_Filters(t *testing.T) {
	r, _ := newTestRouterWithK8s(t)
	marker := "filt" + strings.ReplaceAll(randSuffix(), ".", "")
	create := func(name, display string, tags []string, publish bool) string {
		t.Helper()
		full := name + "-" + marker
		body, _ := json.Marshal(map[string]any{
			"name": full, "display_name": display, "tags": tags, "authoring_mode": "yaml",
			"resources_yaml": minimalResources, "ui_spec_yaml": minimalUISpec,
		})
		w := do(t, r, http.MethodPost, "/v1/templates", bytes.NewReader(body))
		require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
		if publish {
			publishV1(t, r, full)
		}
		return full
	}
	web := create("web", "Web Frontend", []string{"web", "demo"}, true)
	db := create("db", "Database", []string{"db"}, true)
	draft := create("draft", "Draft Web", []string{"web"}, false)

	for query, want := range map[string][]string{
		"":                                    {db, draft, web},
		"?search=web-" + marker:               {web},
		"?search=FRONTEND":                    {web},
		"?tag=web":                            {draft, web},
		"?tag=web&tag=demo":                   {web},
		"?status=published":                   {db, web},
		"?status=draft":                       {draft},
		"?tag=db&status=draft":                nil,
		"?search=" + marker + "&status=draft": {draft},
	} {
		t.Run(query, func(t *testing.T) {
			require.Equal(t, want, listNames(t, r, "/v1/templates"+query, "templates", marker))
		})
	}
}

func TestListReleases_FiltersByClusterNamespaceAndTemplate(t *testing.T) {
	r, _ := newTestRouterWithK8s(t)
	cluster := seedCluster(t, r)
	tplA := seedPublishedTemplate(t, r)
	tplB := seedPublishedTemplate(t, r)
	marker := "filt" + strings.ReplaceAll(randSuffix(), ".", "")
	deploy := func(tpl, namespace, name string) string {
		t.Helper()
		full := name + "-" + marker
		body, _ := json.Marshal(map[string]any{
			"template": tpl, "version": 1, "cluster": cluster, "namespace": namespace,
			"name": full, "values": map[string]any{"Deployment[web].spec.replicas": 1},
		})
		w := do(t, r, http.MethodPost, "/v1/releases", bytes.NewReader(body))
		require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
		return full
	}
	aInA := deploy(tplA, "filt-a", "a1")
	aInB := deploy(tplA, "filt-b", "a2")
	bInA := deploy(tplB, "filt-a", "b1")

	for query, want := range map[string][]string{
		"?template=" + tplA:                               {aInA, aInB},
		"?template=" + tplA + "&namespace=filt-a":         {aInA},
		"?namespace=filt-a":                               {aInA, bInA},
		"?cluster=" + cluster + "&template=" + tplB:       {bInA},
		"?cluster=no-such-cluster&template=" + tplA:       nil,
		"?template=" + tplA + "&namespace=filt-a&limit=1": {aInA},
	} {
		t.Run(query, func(t *testing.T) {
			require.Equal(t, want, listNames(t, r, "/v1/releases"+query, "releases", marker))
		})
	}
}

func TestListEndpoints_RefuseAParameterTheyDoNotTake(t *testing.T) {
	r, _ := newTestRouterWithK8s(t)
	for _, path := range []string{
		"/v1/releases?owner=me",
		"/v1/releases?namespace=prod&sort=name",
		"/v1/templates?namespace=prod",
		"/v1/templates?limit=10",
	} {
		t.Run(path, func(t *testing.T) {
			w := do(t, r, http.MethodGet, path, nil)
			require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
			p := problemShape(t, w.Body.String())
			require.Equal(t, "validation-error", p.Title)
			require.Contains(t, p.Detail, "this endpoint takes")
		})
	}
}
