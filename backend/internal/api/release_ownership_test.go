package api_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/k8s"
)

func createReleaseBody(t *testing.T, cluster, tpl, namespace, name string) *bytes.Reader {
	t.Helper()
	b, err := json.Marshal(map[string]any{
		"template":  tpl,
		"version":   1,
		"cluster":   cluster,
		"namespace": namespace,
		"name":      name,
		"values":    map[string]any{"Deployment[web].spec.replicas": 1},
	})
	require.NoError(t, err)
	return bytes.NewReader(b)
}

func problemOf(t *testing.T, body []byte) (title, detail string) {
	t.Helper()
	var p struct {
		Title  string `json:"title"`
		Detail string `json:"detail"`
	}
	require.NoError(t, json.Unmarshal(body, &p), "not a Problem body: %s", body)
	return p.Title, p.Detail
}

// #161 as it happened live: the objects the template renders are held by
// another release. Nothing may be applied, since an apply is what relabels
// them, and no row may be left claiming a release that was refused.
func TestCreateRelease_RefusesObjectsAnotherReleaseOwns(t *testing.T) {
	r, fk := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	fk.applyCheck = k8s.ApplyCheck{Conflicts: []k8s.Conflict{
		{ObjectRef: k8s.ObjectRef{Kind: "Deployment", Name: "web", Namespace: "default"}, Owner: "web-app-demo"},
	}}
	name := "second-" + randSuffix()

	w := do(t, r, http.MethodPost, "/v1/releases", createReleaseBody(t, clusterName, tplName, "default", name))

	require.Equal(t, http.StatusConflict, w.Code, w.Body.String())
	title, detail := problemOf(t, w.Body.Bytes())
	require.Equal(t, "resource-conflict", title)
	require.Contains(t, detail, `Deployment/web (release "web-app-demo")`)
	require.Contains(t, detail, "A different release name will not help")
	require.Empty(t, fk.applied, "nothing may be applied over another release's objects")
	require.Empty(t, fk.deleted, "a refused create has nothing to clean up, and cleanup by label is what deleted the other release's objects")

	w = do(t, r, http.MethodGet, "/v1/releases", nil)
	require.NotContains(t, w.Body.String(), name, "no row for a release that was refused")
}

// A client branches on the structured list, not on the wording of detail, and
// the deploy form uses it to name the release holding the objects.
func TestCreateRelease_ListsConflictsAsStructuredData(t *testing.T) {
	r, fk := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	fk.applyCheck = k8s.ApplyCheck{Conflicts: []k8s.Conflict{
		{ObjectRef: k8s.ObjectRef{Kind: "CronJob", Name: "nightly", Namespace: "default"}, Owner: "nightly-job-demo"},
		{ObjectRef: k8s.ObjectRef{Kind: "ConfigMap", Name: "stray", Namespace: "default"}},
	}}

	w := do(t, r, http.MethodPost, "/v1/releases", createReleaseBody(t, clusterName, tplName, "default", "rel-"+randSuffix()))

	require.Equal(t, http.StatusConflict, w.Code, w.Body.String())
	var p struct {
		Conflicts []map[string]string `json:"conflicts"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &p))
	require.Equal(t, []map[string]string{
		{"kind": "CronJob", "name": "nightly", "namespace": "default", "owner": "nightly-job-demo"},
		{"kind": "ConfigMap", "name": "stray", "namespace": "default", "owner": ""},
	}, p.Conflicts)
}

// The premise the fail-open on unreadable objects rests on, at the handler: a
// manifest with a readable conflict and an unreadable Secret is refused whole.
// Were any of it applied, the failed-apply cleanup could delete someone else's
// Secret by label.
func TestCreateRelease_AReadableConflictStopsAManifestWithUnreadableObjects(t *testing.T) {
	r, fk := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	fk.applyCheck = k8s.ApplyCheck{
		Conflicts: []k8s.Conflict{
			{ObjectRef: k8s.ObjectRef{Kind: "ConfigMap", Name: "app-config", Namespace: "default"}, Owner: "cfg-demo"},
		},
		Unverified: []k8s.ObjectRef{{Kind: "Secret", Name: "app-secret", Namespace: "default"}},
	}

	w := do(t, r, http.MethodPost, "/v1/releases", createReleaseBody(t, clusterName, tplName, "default", "rel-"+randSuffix()))

	require.Equal(t, http.StatusConflict, w.Code, w.Body.String())
	require.Empty(t, fk.applied, "not one object may be applied, the unreadable Secret included")
	require.Empty(t, fk.deleted)
	_, detail := problemOf(t, w.Body.Bytes())
	require.NotContains(t, detail, "app-secret", "an object the caller cannot read is never reported as held")
}

// An update can land on another release's objects as readily as a create: a
// new version adds one, or an exposed metadata.name renames one.
func TestUpdateRelease_RefusesObjectsAnotherReleaseOwns(t *testing.T) {
	r, fk := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	id := createRelease(t, r, tplName, clusterName, "upd-"+randSuffix(), map[string]any{
		"Deployment[web].spec.replicas": 1,
	})
	appliedBefore := len(fk.applied)
	fk.applyCheck = k8s.ApplyCheck{Conflicts: []k8s.Conflict{
		{ObjectRef: k8s.ObjectRef{Kind: "ConfigMap", Name: "web-config", Namespace: "default"}, Owner: "web-app-demo"},
	}}

	body, err := json.Marshal(map[string]any{
		"version": 1,
		"values":  map[string]any{"Deployment[web].spec.replicas": 2},
	})
	require.NoError(t, err)
	w := do(t, r, http.MethodPut, "/v1/releases/"+id, bytes.NewReader(body))

	require.Equal(t, http.StatusConflict, w.Code, w.Body.String())
	title, _ := problemOf(t, w.Body.Bytes())
	require.Equal(t, "resource-conflict", title)
	require.Len(t, fk.applied, appliedBefore, "an update refused for ownership must not reach apply")

	w = do(t, r, http.MethodGet, "/v1/releases/"+id, nil)
	require.Equal(t, http.StatusOK, w.Code)
	require.NotContains(t, w.Body.String(), "replicas: 2", "the stored release keeps its old values")
}

func TestCreateRelease_SaysWhenTheHolderIsNotKubeport(t *testing.T) {
	r, fk := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	fk.applyCheck = k8s.ApplyCheck{Conflicts: []k8s.Conflict{
		{ObjectRef: k8s.ObjectRef{Kind: "Deployment", Name: "web", Namespace: "default"}},
	}}

	w := do(t, r, http.MethodPost, "/v1/releases", createReleaseBody(t, clusterName, tplName, "default", "rel-"+randSuffix()))

	require.Equal(t, http.StatusConflict, w.Code, w.Body.String())
	_, detail := problemOf(t, w.Body.Bytes())
	require.Contains(t, detail, "Deployment/web (not created by kubeport)")
}

// #137: the template pins a namespace other than the one being deployed into.
// That is the template's fault, so it is a 400 that says what to change, not a
// cluster error, and nothing is applied.
func TestCreateRelease_RefusesATemplatePinnedToAnotherNamespace(t *testing.T) {
	r, fk := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	fk.applyCheckErr = &k8s.NamespaceMismatchError{
		Object:           k8s.ObjectRef{Kind: "Deployment", Name: "web", Namespace: "kube-system"},
		ReleaseNamespace: "default",
	}

	w := do(t, r, http.MethodPost, "/v1/releases", createReleaseBody(t, clusterName, tplName, "default", "rel-"+randSuffix()))

	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	title, detail := problemOf(t, w.Body.Bytes())
	require.Equal(t, "validation-error", title)
	require.Contains(t, detail, "remove metadata.namespace from the template")
	require.Empty(t, fk.applied)
}

// An object the caller may write but not read is not a reason to refuse: the
// demo Role withholds get on Secrets on purpose.
func TestCreateRelease_ProceedsPastObjectsItCannotRead(t *testing.T) {
	r, fk := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	fk.applyCheck = k8s.ApplyCheck{Unverified: []k8s.ObjectRef{
		{Kind: "Secret", Name: "app-secret", Namespace: "default"},
	}}
	name := "rel-" + randSuffix()

	w := do(t, r, http.MethodPost, "/v1/releases", createReleaseBody(t, clusterName, tplName, "default", name))

	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	require.Equal(t, []string{name}, fk.checkedReleases, "the check runs for the release being created")
	require.Len(t, fk.applied, 1)
}

// A failed check is not a clean bill. Reading it as "no conflicts" would apply
// exactly when kubeport could not tell.
func TestCreateRelease_DoesNotApplyWhenTheCheckFails(t *testing.T) {
	r, fk := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	fk.applyCheckErr = errors.New("connection reset")
	name := "rel-" + randSuffix()

	w := do(t, r, http.MethodPost, "/v1/releases", createReleaseBody(t, clusterName, tplName, "default", name))

	require.Equal(t, http.StatusBadGateway, w.Code, w.Body.String())
	title, _ := problemOf(t, w.Body.Bytes())
	require.Equal(t, "k8s-error", title)
	require.Empty(t, fk.applied)

	w = do(t, r, http.MethodGet, "/v1/releases", nil)
	require.NotContains(t, w.Body.String(), name)
}

// #125: a namespace that cannot exist is refused before it is stored, logged,
// or sent to a cluster — and before the ownership check spends a round trip.
func TestCreateRelease_RejectsANamespaceThatCannotExist(t *testing.T) {
	r, fk := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)

	for _, ns := range []string{"Default", "kube_system", "team.a", "a\nb", strings.Repeat("a", 64)} {
		t.Run(strings.ReplaceAll(ns, "\n", `\n`), func(t *testing.T) {
			w := do(t, r, http.MethodPost, "/v1/releases", createReleaseBody(t, clusterName, tplName, ns, "rel-"+randSuffix()))

			require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
			title, detail := problemOf(t, w.Body.Bytes())
			require.Equal(t, "validation-error", title)
			require.Contains(t, detail, "namespace")
			require.NotContains(t, detail, ns, "the value is not echoed back")
		})
	}
	require.Empty(t, fk.checkedReleases)
}

// The name becomes the kubeport.io/release label value, which stops at 63
// characters. A longer name is a valid hostname, so binding let it through and
// the apiserver refused it on apply as a 502.
func TestCreateRelease_RejectsANameTooLongForALabel(t *testing.T) {
	r, fk := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	long := strings.Repeat("a", 40) + "." + strings.Repeat("b", 40)

	w := do(t, r, http.MethodPost, "/v1/releases", createReleaseBody(t, clusterName, tplName, "default", long))

	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	_, detail := problemOf(t, w.Body.Bytes())
	require.Contains(t, detail, "label value")
	require.Empty(t, fk.checkedReleases)
}

// A 400 for a template pinned to another namespace looked like every other 400
// on the deploy form, which tells the user to check their input: the one thing
// that is not wrong. The structured field is what lets it say otherwise.
func TestCreateRelease_PinnedNamespaceIsStructured(t *testing.T) {
	r, fk := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	fk.applyCheckErr = &k8s.NamespaceMismatchError{
		Object:           k8s.ObjectRef{Kind: "Deployment", Name: "web", Namespace: "kube-system"},
		ReleaseNamespace: "default",
	}

	w := do(t, r, http.MethodPost, "/v1/releases", createReleaseBody(t, clusterName, tplName, "default", "rel-"+randSuffix()))

	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	var p struct {
		PinnedNamespace map[string]string `json:"pinned_namespace"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &p))
	require.Equal(t, map[string]string{"kind": "Deployment", "name": "web", "namespace": "kube-system"}, p.PinnedNamespace)
}

// Only a create may probe objects the caller cannot read. A dry-run create
// cannot tell an update's own object from anyone else's.
func TestReleases_OnlyACreateProbesUnreadableObjects(t *testing.T) {
	r, fk := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	id := createRelease(t, r, tplName, clusterName, "probe-"+randSuffix(), map[string]any{
		"Deployment[web].spec.replicas": 1,
	})
	require.Equal(t, []bool{true}, fk.checkedCreating)

	body, err := json.Marshal(map[string]any{"version": 1, "values": map[string]any{"Deployment[web].spec.replicas": 2}})
	require.NoError(t, err)
	w := do(t, r, http.MethodPut, "/v1/releases/"+id, bytes.NewReader(body))

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, []bool{true, false}, fk.checkedCreating)
}

// An update cannot move namespace, so the advice that suits a create is
// impossible there, for a conflict and for a pinned namespace alike.
func TestUpdateRelease_AdviceFitsAnExistingRelease(t *testing.T) {
	r, fk := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	id := createRelease(t, r, tplName, clusterName, "advice-"+randSuffix(), map[string]any{
		"Deployment[web].spec.replicas": 1,
	})
	body, err := json.Marshal(map[string]any{"version": 1, "values": map[string]any{"Deployment[web].spec.replicas": 2}})
	require.NoError(t, err)

	fk.applyCheck = k8s.ApplyCheck{Conflicts: []k8s.Conflict{
		{ObjectRef: k8s.ObjectRef{Kind: "ConfigMap", Name: "web-config", Namespace: "default"}, Owner: "web-app-demo"},
	}}
	w := do(t, r, http.MethodPut, "/v1/releases/"+id, bytes.NewReader(body))
	require.Equal(t, http.StatusConflict, w.Code, w.Body.String())
	_, detail := problemOf(t, w.Body.Bytes())
	require.NotContains(t, detail, "deploy into another namespace")
	require.Contains(t, detail, "cannot move namespace")

	fk.applyCheck = k8s.ApplyCheck{}
	fk.applyCheckErr = &k8s.NamespaceMismatchError{
		Object:           k8s.ObjectRef{Kind: "Deployment", Name: "web", Namespace: "kube-system"},
		ReleaseNamespace: "default",
	}
	w = do(t, r, http.MethodPut, "/v1/releases/"+id, bytes.NewReader(body))
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	_, detail = problemOf(t, w.Body.Bytes())
	require.NotContains(t, detail, "deploy the release into")
	require.Contains(t, detail, "cannot change namespace")
}

// An object shown to exist by a dry-run create has no readable owner. Calling
// it "not created by kubeport" would be a guess presented as fact.
func TestCreateRelease_DoesNotGuessAnUnreadableHolder(t *testing.T) {
	r, fk := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	fk.applyCheck = k8s.ApplyCheck{Conflicts: []k8s.Conflict{
		{ObjectRef: k8s.ObjectRef{Kind: "Secret", Name: "app-secret", Namespace: "default"}, OwnerUnknown: true},
	}}

	w := do(t, r, http.MethodPost, "/v1/releases", createReleaseBody(t, clusterName, tplName, "default", "rel-"+randSuffix()))

	require.Equal(t, http.StatusConflict, w.Code, w.Body.String())
	_, detail := problemOf(t, w.Body.Bytes())
	require.Contains(t, detail, "cannot read who holds it")
	require.NotContains(t, detail, "not created by kubeport")
	var p struct {
		Conflicts []struct {
			OwnerUnknown bool `json:"owner_unknown"`
		} `json:"conflicts"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &p))
	require.Len(t, p.Conflicts, 1)
	require.True(t, p.Conflicts[0].OwnerUnknown)
	require.Empty(t, fk.applied)
}
