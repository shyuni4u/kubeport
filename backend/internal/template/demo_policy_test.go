package template_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"

	"kubeport/internal/template"
)

// Issue #350. A demo account's rendered manifest is held to limits that bound
// what one visitor leaves on the node: finished Job pods, and the images their
// pods pull. An unset limit is filled; one set above the limit is refused.

func i64(n int64) *int64 { return &n }

func demoDocs(t *testing.T, out []byte) map[string]map[string]any {
	t.Helper()
	docs := map[string]map[string]any{}
	dec := yaml.NewDecoder(bytes.NewReader(out))
	for {
		var d map[string]any
		err := dec.Decode(&d)
		if errors.Is(err, io.EOF) {
			break
		}
		require.NoError(t, err)
		docs[d["kind"].(string)+"/"+d["metadata"].(map[string]any)["name"].(string)] = d
	}
	return docs
}

const demoJobs = `apiVersion: batch/v1
kind: Job
metadata: { name: once }
spec:
  template:
    spec:
      restartPolicy: Never
      containers: [{ name: job, image: busybox:1.36 }]
---
apiVersion: batch/v1
kind: CronJob
metadata: { name: nightly }
spec:
  schedule: "0 3 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers: [{ name: job, image: busybox:1.36 }]
`

var jobLimits = template.DemoPolicy{
	JobBackoffLimit:            i64(2),
	JobTTLSecondsAfterFinished: i64(86400),
	CronJobHistoryLimit:        i64(1),
}

func TestApplyDemoPolicy_FillsJobLimitsATemplateLeavesUnset(t *testing.T) {
	out, violations, err := template.ApplyDemoPolicy([]byte(demoJobs), jobLimits)
	require.NoError(t, err)
	require.Empty(t, violations)
	docs := demoDocs(t, out)

	job := docs["Job/once"]["spec"].(map[string]any)
	require.EqualValues(t, 2, job["backoffLimit"])
	require.EqualValues(t, 86400, job["ttlSecondsAfterFinished"])

	cron := docs["CronJob/nightly"]["spec"].(map[string]any)
	require.EqualValues(t, 1, cron["successfulJobsHistoryLimit"])
	require.EqualValues(t, 1, cron["failedJobsHistoryLimit"])
	jobTemplate := cron["jobTemplate"].(map[string]any)["spec"].(map[string]any)
	require.EqualValues(t, 2, jobTemplate["backoffLimit"])
	require.NotContains(t, jobTemplate, "ttlSecondsAfterFinished",
		"a CronJob's jobs are bounded by its history, so a job the demo shows failing stays visible until the reset")
}

func TestApplyDemoPolicy_KeepsLimitsSetWithinTheCap(t *testing.T) {
	within := `apiVersion: batch/v1
kind: Job
metadata: { name: once }
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 60
  template: { spec: { restartPolicy: Never, containers: [{ name: job, image: busybox }] } }
---
apiVersion: batch/v1
kind: CronJob
metadata: { name: nightly }
spec:
  schedule: "0 3 * * *"
  successfulJobsHistoryLimit: 0
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      backoffLimit: 1
      ttlSecondsAfterFinished: 999999
      template: { spec: { restartPolicy: Never, containers: [{ name: job, image: busybox }] } }
`
	out, violations, err := template.ApplyDemoPolicy([]byte(within), jobLimits)
	require.NoError(t, err)
	require.Empty(t, violations)
	docs := demoDocs(t, out)
	require.EqualValues(t, 0, docs["Job/once"]["spec"].(map[string]any)["backoffLimit"])
	require.EqualValues(t, 60, docs["Job/once"]["spec"].(map[string]any)["ttlSecondsAfterFinished"])
	cron := docs["CronJob/nightly"]["spec"].(map[string]any)
	require.EqualValues(t, 0, cron["successfulJobsHistoryLimit"])
	require.EqualValues(t, 999999, cron["jobTemplate"].(map[string]any)["spec"].(map[string]any)["ttlSecondsAfterFinished"],
		"no ttl rule on a CronJob's job template, in either direction")
}

func TestApplyDemoPolicy_RefusesLimitsSetAboveTheCap(t *testing.T) {
	over := `apiVersion: batch/v1
kind: Job
metadata: { name: once }
spec:
  backoffLimit: 6
  ttlSecondsAfterFinished: 172800
  template: { spec: { restartPolicy: Never, containers: [{ name: job, image: busybox }] } }
---
apiVersion: batch/v1
kind: CronJob
metadata: { name: nightly }
spec:
  schedule: "0 3 * * *"
  successfulJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 4
      template: { spec: { restartPolicy: Never, containers: [{ name: job, image: busybox }] } }
`
	out, violations, err := template.ApplyDemoPolicy([]byte(over), jobLimits)
	require.NoError(t, err)
	require.Nil(t, out)
	require.ElementsMatch(t, []template.DemoViolation{
		{Rule: "job-backoff-limit", Kind: "Job", Name: "once", Field: "spec.backoffLimit", Limit: i64(2), Got: 6},
		{Rule: "job-ttl", Kind: "Job", Name: "once", Field: "spec.ttlSecondsAfterFinished", Limit: i64(86400), Got: 172800},
		{Rule: "cronjob-history-limit", Kind: "CronJob", Name: "nightly", Field: "spec.successfulJobsHistoryLimit", Limit: i64(1), Got: 3},
		{Rule: "job-backoff-limit", Kind: "CronJob", Name: "nightly", Field: "spec.jobTemplate.spec.backoffLimit", Limit: i64(2), Got: 4},
	}, violations, "every violation at once, so a caller does not fix one and meet the next")
}

func TestApplyDemoPolicy_OffLeavesTheManifestUntouched(t *testing.T) {
	out, violations, err := template.ApplyDemoPolicy([]byte(demoJobs), template.DemoPolicy{})
	require.NoError(t, err)
	require.Empty(t, violations)
	require.Equal(t, demoJobs, string(out), "byte for byte")
}

func TestApplyDemoPolicy_ImagePrefixes(t *testing.T) {
	manifest := `apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  template:
    spec:
      initContainers: [{ name: init, image: quay.io/evil/init:1 }]
      containers:
        - { name: web, image: "ghcr.io/nginx/nginx-unprivileged:1.27-alpine" }
        - { name: side, image: "busybox:1.36" }
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: db }
spec:
  template: { spec: { containers: [{ name: db, image: "docker.io/library/busybox-evil:1" }] } }
---
apiVersion: apps/v1
kind: DaemonSet
metadata: { name: agent }
spec:
  template: { spec: { containers: [{ name: agent, image: "ghcr.io/does-not-exist/nightly:0.0.0" }] } }
---
apiVersion: batch/v1
kind: CronJob
metadata: { name: nightly }
spec:
  schedule: "0 3 * * *"
  jobTemplate: { spec: { template: { spec: { containers: [{ name: job, image: "nginx/other" }] } } } }
---
apiVersion: v1
kind: Pod
metadata: { name: bare }
spec:
  containers: [{ name: bare, image: "busybox@sha256:abc" }]
`
	policy := template.DemoPolicy{ImagePrefixes: []string{"ghcr.io/nginx/", "busybox", "ghcr.io/does-not-exist/"}}
	_, violations, err := template.ApplyDemoPolicy([]byte(manifest), policy)
	require.NoError(t, err)
	require.ElementsMatch(t, []template.DemoViolation{
		{Rule: "image-prefix", Kind: "Deployment", Name: "web", Container: "init", Field: "spec.template.spec.initContainers[0].image", Got: "quay.io/evil/init:1"},
		{Rule: "image-prefix", Kind: "StatefulSet", Name: "db", Container: "db", Field: "spec.template.spec.containers[0].image", Got: "docker.io/library/busybox-evil:1"},
		{Rule: "image-prefix", Kind: "CronJob", Name: "nightly", Container: "job", Field: "spec.jobTemplate.spec.template.spec.containers[0].image", Got: "nginx/other"},
	}, violations,
		"busybox admits busybox:1.36 and busybox@sha256 but not busybox-evil; nginx/other is Docker Hub's, not ghcr.io/nginx")
}

// The demo seeds its releases through the API as the demo user, so the default
// policy must pass them as they are — refusing one would leave the reset wiped
// and unseeded (#105). Both seed releases, with the prefixes the live demo
// would need, pass; the nightly job is filled, not refused.
func TestApplyDemoPolicy_PassesTheDemoSeed(t *testing.T) {
	dir := filepath.Join("..", "..", "cmd", "seed-demo", "fixtures")
	policy := jobLimits
	policy.ImagePrefixes = []string{"ghcr.io/nginx/", "docker.io/library/busybox", "ghcr.io/does-not-exist/"}
	for _, tc := range []struct{ template, values string }{
		{"app-with-config", `{"ConfigMap[app-config].data.REGION":"kr","Secret[app-secret].stringData.API_KEY":"demo-placeholder-not-a-secret"}`},
		{"nightly-job", `{"CronJob[nightly].spec.jobTemplate.spec.template.spec.containers[0].image":"ghcr.io/does-not-exist/nightly:0.0.0"}`},
		{"web-app", `{}`},
	} {
		t.Run(tc.template, func(t *testing.T) {
			resources, err := os.ReadFile(filepath.Join(dir, tc.template+".resources.yaml"))
			require.NoError(t, err)
			uiSpec, err := os.ReadFile(filepath.Join(dir, tc.template+".ui-spec.yaml"))
			require.NoError(t, err)
			rendered, err := template.Render(string(resources), string(uiSpec), json.RawMessage(tc.values), template.Labels{
				ReleaseName: tc.template + "-demo", TemplateName: tc.template, TemplateVersion: 1, ReleaseID: "id",
			})
			require.NoError(t, err)
			out, violations, err := template.ApplyDemoPolicy(rendered, policy)
			require.NoError(t, err)
			require.Empty(t, violations)
			require.NotEmpty(t, out)
		})
	}
}
