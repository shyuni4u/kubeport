package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/config"
	"kubeport/internal/store"
)

// Issue #350. A demo account's rendered manifest is held to the demo's limits
// on create, update and preview: an unset limit is filled, one set higher is
// refused with 403 demo-restricted and demo_policy. Nobody else is affected.

func ptr64(n int64) *int64 { return &n }

var demoPolicyConfig = config.Config{
	DemoJobBackoffLimit:            ptr64(2),
	DemoJobTTLSecondsAfterFinished: ptr64(86400),
	DemoCronJobHistoryLimit:        ptr64(1),
	DemoAllowedImagePrefixes:       []string{"ghcr.io/nginx/", "docker.io/library/busybox", "ghcr.io/does-not-exist/"},
}

const cronJobResources = `apiVersion: batch/v1
kind: CronJob
metadata: { name: nightly }
spec:
  schedule: "0 3 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers: [{ name: job, image: "busybox:1.36" }]
`

const cronJobOverLimit = `apiVersion: batch/v1
kind: CronJob
metadata: { name: nightly }
spec:
  schedule: "0 3 * * *"
  failedJobsHistoryLimit: 5
  jobTemplate:
    spec:
      backoffLimit: 6
      template:
        spec:
          restartPolicy: Never
          containers: [{ name: job, image: "busybox:1.36" }]
`

const foreignImageResources = `apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers: [{ name: web, image: "quay.io/someone/huge:1" }]
`

// publishTemplate creates and publishes a template with no fields through
// router, owned by whoever router signs in as.
func publishTemplate(t *testing.T, router http.Handler, resources string) string {
	t.Helper()
	name := "policy-" + randSuffix()
	body, err := json.Marshal(map[string]any{
		"name": name, "display_name": "Policy", "authoring_mode": "yaml",
		"resources_yaml": resources, "ui_spec_yaml": "fields: []\n",
	})
	require.NoError(t, err)
	w := do(t, router, http.MethodPost, "/v1/templates", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	publishV1(t, router, name)
	return name
}

func policyDeployBody(t *testing.T, tpl, cluster string) *bytes.Reader {
	t.Helper()
	b, err := json.Marshal(map[string]any{
		"template": tpl, "version": 1, "cluster": cluster, "namespace": "default",
		"name": "policy-" + randSuffix(), "values": map[string]any{},
	})
	require.NoError(t, err)
	return bytes.NewReader(b)
}

// demoUserRouter signs in as a demo account, with cfg's policy.
func demoUserRouter(s *store.Store, cfg config.Config, applier *fakeK8sApplier) http.Handler {
	return api.NewRouter(cfg, api.Deps{
		Verifier:        demoVerifier{email: "demo-user@" + demoDomain},
		Store:           s,
		K8sFactory:      &fakeK8sFactory{applier: applier},
		DemoEmailDomain: demoDomain,
	})
}

type demoPolicyProblem struct {
	Title      string `json:"title"`
	Detail     string `json:"detail"`
	DemoPolicy []struct {
		Rule  string `json:"rule"`
		Kind  string `json:"kind"`
		Name  string `json:"name"`
		Field string `json:"field"`
		Limit *int64 `json:"limit"`
		Got   any    `json:"got"`
	} `json:"demo_policy"`
}

func decodePolicyProblem(t *testing.T, body []byte) demoPolicyProblem {
	t.Helper()
	var p demoPolicyProblem
	require.NoError(t, json.Unmarshal(body, &p))
	return p
}

func TestCreateRelease_DemoPolicyFillsUnsetLimits(t *testing.T) {
	s := testStore(t)
	admin := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	clusterName := seedCluster(t, admin)
	tpl := publishTemplate(t, newDemoAdminRouterWithTemplateCreate(t, s), cronJobResources)

	applier := &fakeK8sApplier{}
	w := do(t, demoUserRouter(s, demoPolicyConfig, applier), http.MethodPost, "/v1/releases", policyDeployBody(t, tpl, clusterName))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	require.Len(t, applier.applied, 1)
	applied := string(applier.applied[0])
	require.Contains(t, applied, "backoffLimit: 2")
	require.Contains(t, applied, "successfulJobsHistoryLimit: 1")
	require.Contains(t, applied, "failedJobsHistoryLimit: 1")
	require.NotContains(t, applied, "ttlSecondsAfterFinished", "a CronJob's jobs keep no ttl rule")

	var rel struct {
		RenderedYAML string `json:"rendered_yaml"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &rel))
	require.Contains(t, rel.RenderedYAML, "backoffLimit: 2", "what is stored is what was applied")
}

func TestCreateRelease_DemoPolicyRefusesLimitsSetHigher(t *testing.T) {
	s := testStore(t)
	admin := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	clusterName := seedCluster(t, admin)
	tpl := publishTemplate(t, newDemoAdminRouterWithTemplateCreate(t, s), cronJobOverLimit)

	applier := &fakeK8sApplier{}
	w := do(t, demoUserRouter(s, demoPolicyConfig, applier), http.MethodPost, "/v1/releases", policyDeployBody(t, tpl, clusterName))
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	p := decodePolicyProblem(t, w.Body.Bytes())
	require.Equal(t, "demo-restricted", p.Title)
	require.Len(t, p.DemoPolicy, 2, "every violation at once")
	rules := []string{p.DemoPolicy[0].Rule, p.DemoPolicy[1].Rule}
	require.ElementsMatch(t, []string{"cronjob-history-limit", "job-backoff-limit"}, rules)
	require.Empty(t, applier.applied, "nothing is applied")

	w = do(t, admin, http.MethodGet, "/v1/releases?template="+tpl, nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NotContains(t, w.Body.String(), tpl+`"`, "no row is left behind")
}

func TestCreateRelease_DemoPolicyNeverNamesTheAllowedImages(t *testing.T) {
	s := testStore(t)
	admin := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	clusterName := seedCluster(t, admin)
	tpl := publishTemplate(t, newDemoAdminRouterWithTemplateCreate(t, s), foreignImageResources)

	w := do(t, demoUserRouter(s, demoPolicyConfig, &fakeK8sApplier{}), http.MethodPost, "/v1/releases", policyDeployBody(t, tpl, clusterName))
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	p := decodePolicyProblem(t, w.Body.Bytes())
	require.Len(t, p.DemoPolicy, 1)
	require.Equal(t, "image-prefix", p.DemoPolicy[0].Rule)
	require.Equal(t, "quay.io/someone/huge:1", p.DemoPolicy[0].Got)
	for _, prefix := range demoPolicyConfig.DemoAllowedImagePrefixes {
		require.False(t, strings.Contains(w.Body.String(), prefix), "the response names %q", prefix)
	}
}

func TestCreateRelease_DemoPolicyLeavesOtherCallersAlone(t *testing.T) {
	s := testStore(t)
	applier := &fakeK8sApplier{}
	admin := api.NewRouter(demoPolicyConfig, api.Deps{
		Verifier: adminVerifier{}, Store: s, K8sFactory: &fakeK8sFactory{applier: applier}, DemoEmailDomain: demoDomain,
	})
	clusterName := seedCluster(t, admin)
	tpl := publishTemplate(t, admin, cronJobOverLimit)

	w := do(t, admin, http.MethodPost, "/v1/releases", policyDeployBody(t, tpl, clusterName))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	require.Len(t, applier.applied, 1)
	require.Contains(t, string(applier.applied[0]), "backoffLimit: 6", "an operator's manifest is not the demo's to limit")
}

func TestCreateRelease_DemoPolicyOffLeavesDemoCallersAlone(t *testing.T) {
	s := testStore(t)
	admin := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	clusterName := seedCluster(t, admin)
	tpl := publishTemplate(t, newDemoAdminRouterWithTemplateCreate(t, s), cronJobResources)

	applier := &fakeK8sApplier{}
	w := do(t, demoUserRouter(s, config.Config{}, applier), http.MethodPost, "/v1/releases", policyDeployBody(t, tpl, clusterName))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	require.NotContains(t, string(applier.applied[0]), "backoffLimit")
}

// An existing demo release takes the limits on its next update.
func TestUpdateRelease_DemoPolicyRefusesLimitsSetHigher(t *testing.T) {
	s := testStore(t)
	admin := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	clusterName := seedCluster(t, admin)
	tpl := publishTemplate(t, newDemoAdminRouterWithTemplateCreate(t, s), cronJobOverLimit)

	// Deployed before the policy was on.
	w := do(t, demoUserRouter(s, config.Config{}, &fakeK8sApplier{}), http.MethodPost, "/v1/releases", policyDeployBody(t, tpl, clusterName))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	var rel struct {
		ID string `json:"id"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &rel))

	applier := &fakeK8sApplier{}
	body, _ := json.Marshal(map[string]any{"version": 1, "values": map[string]any{}})
	w = do(t, demoUserRouter(s, demoPolicyConfig, applier), http.MethodPut, "/v1/releases/"+rel.ID, bytes.NewReader(body))
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	require.Equal(t, "demo-restricted", decodePolicyProblem(t, w.Body.Bytes()).Title)
	require.Empty(t, applier.applied)
}

func TestPreviewRender_DemoPolicyShowsWhatADeployWouldGet(t *testing.T) {
	s := testStore(t)
	demoAdmin := newDemoAdminRouterWithTemplateCreate(t, s)
	filled := publishTemplate(t, demoAdmin, cronJobResources)
	over := publishTemplate(t, demoAdmin, cronJobOverLimit)
	router := demoUserRouter(s, demoPolicyConfig, &fakeK8sApplier{})
	empty := []byte(`{"values":{}}`)

	w := do(t, router, http.MethodPost, "/v1/templates/"+filled+"/render", bytes.NewReader(empty))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "backoffLimit: 2")

	w = do(t, router, http.MethodPost, "/v1/templates/"+over+"/render", bytes.NewReader(empty))
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	require.Equal(t, "demo-restricted", decodePolicyProblem(t, w.Body.Bytes()).Title)
}
