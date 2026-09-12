package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
)

// Issue #294. Demo accounts are shared by every visitor, and they can write a
// Deployment and read pod logs in the demo namespace. Publishing a version was
// open to them, so a visitor could publish one that echoes another visitor's
// Secret through env.valueFrom and read it back from the release's logs.
// Publishing is gated like creating a template: refused unless the install
// opted in with KBP_DEMO_ALLOW_TEMPLATE_CREATE. Drafts stay open, so the editor
// tour does not change — and a draft cannot be deployed (#252).

func TestDemoAdmin_CannotPublishByDefault(t *testing.T) {
	s := testStore(t)
	optedIn := newDemoAdminRouterWithTemplateCreate(t, s)
	tpl := "demo-authored-" + randSuffix()
	w := do(t, optedIn, http.MethodPost, "/v1/templates", bytes.NewReader(createTemplateBody(tpl)))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())

	gated := newDemoAdminRouter(t, s, &fakeK8sApplier{})
	w = do(t, gated, http.MethodPost, "/v1/templates/"+tpl+"/versions/1/publish", nil)
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	require.Equal(t, "demo-restricted", problemShape(t, w.Body.String()).Title)

	w = do(t, gated, http.MethodGet, "/v1/templates/"+tpl+"/versions/1", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var v struct {
		Status string `json:"status"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &v))
	require.Equal(t, "draft", v.Status, "the refused publish must not have happened")
}

// The gate answers the same for a name the demo cannot see or that does not
// exist, so it says nothing about which templates are there.
func TestDemoAdmin_PublishRefusalDoesNotDependOnTheTemplate(t *testing.T) {
	s := testStore(t)
	gated := newDemoAdminRouter(t, s, &fakeK8sApplier{})

	w := do(t, gated, http.MethodPost, "/v1/templates/no-such-"+randSuffix()+"/versions/1/publish", nil)
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	require.Equal(t, "demo-restricted", problemShape(t, w.Body.String()).Title)
}

// Security review: undeprecate makes a version published again, and any
// published version can be deployed. It is gated like publish; deprecating
// only removes a version from the catalog and stays open.
func TestDemoAdmin_CannotUndeprecateByDefault(t *testing.T) {
	s := testStore(t)
	optedIn := newDemoAdminRouterWithTemplateCreate(t, s)
	tpl := "demo-authored-" + randSuffix()
	w := do(t, optedIn, http.MethodPost, "/v1/templates", bytes.NewReader(createTemplateBody(tpl)))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	publishV1(t, optedIn, tpl)

	gated := newDemoAdminRouter(t, s, &fakeK8sApplier{})
	w = do(t, gated, http.MethodPost, "/v1/templates/"+tpl+"/versions/1/deprecate", nil)
	require.Equal(t, http.StatusOK, w.Code, "deprecating stays open: %s", w.Body.String())

	w = do(t, gated, http.MethodPost, "/v1/templates/"+tpl+"/versions/1/undeprecate", nil)
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	require.Equal(t, "demo-restricted", problemShape(t, w.Body.String()).Title)

	w = do(t, gated, http.MethodGet, "/v1/templates/"+tpl+"/versions/1", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var v struct {
		Status string `json:"status"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &v))
	require.Equal(t, "deprecated", v.Status, "the refused undeprecate must not have happened")
}

// Drafts stay open to the demo: adding a version to a demo template is the
// editor tour.
func TestDemoAdmin_CanStillAddADraftVersion(t *testing.T) {
	s := testStore(t)
	optedIn := newDemoAdminRouterWithTemplateCreate(t, s)
	tpl := "demo-authored-" + randSuffix()
	w := do(t, optedIn, http.MethodPost, "/v1/templates", bytes.NewReader(createTemplateBody(tpl)))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	publishV1(t, optedIn, tpl)

	gated := newDemoAdminRouter(t, s, &fakeK8sApplier{})
	body, _ := json.Marshal(map[string]any{
		"authoring_mode": "yaml", "resources_yaml": minimalResources, "ui_spec_yaml": minimalUISpec,
	})
	w = do(t, gated, http.MethodPost, "/v1/templates/"+tpl+"/versions", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
}
