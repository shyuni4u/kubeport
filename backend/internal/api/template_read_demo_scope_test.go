package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/auth"
	"kubeport/internal/config"
)

// Issue #238. The template list (#226's inDemoScope) and deploying both keep
// demo content and the operator's apart, but reading a single template by
// name did not: a demo visitor — whose password is printed on the landing page
// — could fetch an operator template's full resources.yaml, and a real user a
// demo one's. Every item route now answers a template on the other side of the
// line the way the list does, by omission: 404, with nothing in the body.

type templateRead struct{ method, path string }

// readsOf lists every route that returns a template's content.
func readsOf(name string) []templateRead {
	return []templateRead{
		{http.MethodGet, "/v1/templates/" + name},
		{http.MethodGet, "/v1/templates/" + name + "/versions"},
		{http.MethodGet, "/v1/templates/" + name + "/versions/1"},
		{http.MethodPost, "/v1/templates/" + name + "/render"},
		{http.MethodPost, "/v1/templates/" + name + "/render?version=1"},
	}
}

func readTemplate(t *testing.T, r http.Handler, rd templateRead) (int, string) {
	t.Helper()
	if rd.method == http.MethodPost {
		b, _ := json.Marshal(map[string]any{"values": demoValues})
		w := do(t, r, rd.method, rd.path, bytes.NewReader(b))
		return w.Code, w.Body.String()
	}
	w := do(t, r, rd.method, rd.path, nil)
	return w.Code, w.Body.String()
}

func demoScopeRouter(t *testing.T, email string, admin bool) http.Handler {
	t.Helper()
	claims := auth.Claims{Subject: "reader-" + randSuffix(), Email: email}
	if admin {
		claims.Groups = []string{"kubeport-admin"}
	}
	return api.NewRouter(config.Config{}, api.Deps{
		Verifier:        customVerifier{claims: claims},
		Store:           testStore(t),
		DemoEmailDomain: demoDomain,
	})
}

func TestTemplateReads_HideTheOtherSideOfTheDemoLine(t *testing.T) {
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	operatorTpl := seedPublishedTemplate(t, adminRouter)
	demoTpl := seedDemoTemplate(t, s)

	demoAdmin := demoScopeRouter(t, "demo-admin@"+demoDomain, true)
	realUser := demoScopeRouter(t, "real-"+randSuffix()+"@example.com", false)

	for _, tc := range []struct {
		who      string
		r        http.Handler
		template string
	}{
		{"demo admin reading the operator's template", demoAdmin, operatorTpl},
		{"real user reading a demo template", realUser, demoTpl},
	} {
		for _, rd := range readsOf(tc.template) {
			code, body := readTemplate(t, tc.r, rd)
			require.Equal(t, http.StatusNotFound, code, "%s: %s %s: %s", tc.who, rd.method, rd.path, body)
			require.Contains(t, body, "not-found")
			require.NotContains(t, body, "resources_yaml")
			require.NotContains(t, body, "rendered_yaml")
		}
	}
}

// The other half: the line must not refuse anyone the catalog shows the
// template to.
func TestTemplateReads_LeaveTheirOwnSideOpen(t *testing.T) {
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	operatorTpl := seedPublishedTemplate(t, adminRouter)
	demoTpl := seedDemoTemplate(t, s)

	operator := demoScopeRouter(t, "operator-"+randSuffix()+"@example.com", true)
	demoUser := demoScopeRouter(t, "demo-user@"+demoDomain, false)
	realUser := demoScopeRouter(t, "real-"+randSuffix()+"@example.com", false)

	for _, tc := range []struct {
		who      string
		r        http.Handler
		template string
	}{
		{"operator reading the operator's template", operator, operatorTpl},
		{"operator reading a demo template", operator, demoTpl},
		{"demo-user reading a demo template", demoUser, demoTpl},
		{"real user reading the operator's template", realUser, operatorTpl},
	} {
		for _, rd := range readsOf(tc.template) {
			code, body := readTemplate(t, tc.r, rd)
			require.Equal(t, http.StatusOK, code, "%s: %s %s: %s", tc.who, rd.method, rd.path, body)
		}
	}
}
