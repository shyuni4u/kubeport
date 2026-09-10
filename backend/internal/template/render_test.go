package template_test

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"

	"kubeport/internal/template"
)

const resourcesYAML = `
apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: app
          image: placeholder
---
apiVersion: v1
kind: Service
metadata: { name: web }
spec:
  ports: [{ port: 80 }]
`

const uiSpecYAML = `
fields:
  - path: Deployment[web].spec.replicas
    label: "인스턴스 개수"
    type: integer
    min: 1
    max: 20
    default: 3
  - path: Deployment[web].spec.template.spec.containers[0].image
    label: "Image"
    type: string
`

func TestRender_AppliesValuesAndStampsLabels(t *testing.T) {
	values, _ := json.Marshal(map[string]any{
		"Deployment[web].spec.replicas":                          5,
		"Deployment[web].spec.template.spec.containers[0].image": "nginx:1.25",
	})

	out, err := template.Render(resourcesYAML, uiSpecYAML, values, template.Labels{
		ReleaseName: "my-api", TemplateName: "web-service",
		TemplateVersion: 2, ReleaseID: "rel_abc", AppliedBy: "alice@example.com",
	})
	require.NoError(t, err)

	var docs []map[string]any
	dec := yaml.NewDecoder(bytes.NewReader(out))
	for {
		m := map[string]any{}
		if err := dec.Decode(&m); err != nil {
			break
		}
		docs = append(docs, m)
	}
	require.Len(t, docs, 2)

	dep := docs[0]
	spec := dep["spec"].(map[string]any)
	require.Equal(t, 5, spec["replicas"])

	ctrs := spec["template"].(map[string]any)["spec"].(map[string]any)["containers"].([]any)
	require.Equal(t, "nginx:1.25", ctrs[0].(map[string]any)["image"])

	meta := dep["metadata"].(map[string]any)
	lbls := meta["labels"].(map[string]any)
	require.Equal(t, "my-api", lbls["kubeport.io/release"])
	require.Equal(t, "2", lbls["kubeport.io/template-version"])
	// #195: the id is a label, on the object and on its pods.
	require.Equal(t, "rel_abc", lbls["kubeport.io/release-uid"])
	podLbls := spec["template"].(map[string]any)["metadata"].(map[string]any)["labels"].(map[string]any)
	require.Equal(t, "rel_abc", podLbls["kubeport.io/release-uid"])
}

// A workload's selector is immutable. The id goes on pod template labels only;
// in the selector it would refuse every update of an existing release.
func TestRender_LeavesWorkloadSelectorsAlone(t *testing.T) {
	const res = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: nginx
`
	out, err := template.Render(res, "fields: []\n", json.RawMessage(`{}`), template.Labels{
		ReleaseName: "r", TemplateName: "t", TemplateVersion: 1, ReleaseID: "11111111-1111-1111-1111-111111111111",
	})
	require.NoError(t, err)

	var doc map[string]any
	require.NoError(t, yaml.Unmarshal(out, &doc))
	spec := doc["spec"].(map[string]any)
	require.Equal(t, map[string]any{"matchLabels": map[string]any{"app": "web"}}, spec["selector"])
	podLbls := spec["template"].(map[string]any)["metadata"].(map[string]any)["labels"].(map[string]any)
	require.Equal(t, "11111111-1111-1111-1111-111111111111", podLbls["kubeport.io/release-uid"])
}

// A Job's pod template is immutable, so a release with a Job applied before the
// id existed could not be updated once the id appeared in it. The Job carries
// the id; its pods do not. A CronJob's job template can change, so its pods do.
func TestRender_KeepsTheIDOffAJobsPodTemplate(t *testing.T) {
	const res = `apiVersion: batch/v1
kind: Job
metadata:
  name: once
spec:
  template:
    spec:
      containers:
        - name: once
          image: busybox
      restartPolicy: Never
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly
spec:
  schedule: "0 3 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: nightly
              image: busybox
          restartPolicy: Never
`
	const uid = "11111111-1111-1111-1111-111111111111"
	out, err := template.Render(res, "fields: []\n", json.RawMessage(`{}`), template.Labels{
		ReleaseName: "r", TemplateName: "t", TemplateVersion: 1, ReleaseID: uid,
	})
	require.NoError(t, err)

	var docs []map[string]any
	dec := yaml.NewDecoder(bytes.NewReader(out))
	for {
		m := map[string]any{}
		if err := dec.Decode(&m); err != nil {
			break
		}
		docs = append(docs, m)
	}
	require.Len(t, docs, 2)
	labelsAt := func(m map[string]any, path ...string) map[string]any {
		for _, p := range path {
			m = m[p].(map[string]any)
		}
		return m["labels"].(map[string]any)
	}

	job, cron := docs[0], docs[1]
	require.Equal(t, uid, labelsAt(job, "metadata")["kubeport.io/release-uid"])
	jobPod := labelsAt(job, "spec", "template", "metadata")
	require.NotContains(t, jobPod, "kubeport.io/release-uid")
	require.Equal(t, "r", jobPod["kubeport.io/release"], "the pods still carry the name")
	require.Equal(t, uid, labelsAt(cron, "spec", "jobTemplate", "spec", "template", "metadata")["kubeport.io/release-uid"])
}

// A preview renders for no release, so there is no id to stamp — and an empty
// label would match every unstamped object a selector on it was meant to skip.
func TestRender_WithoutAReleaseIDStampsNoIDLabel(t *testing.T) {
	values, _ := json.Marshal(map[string]any{"Deployment[web].spec.replicas": 3})

	out, err := template.Render(resourcesYAML, uiSpecYAML, values, template.Labels{ReleaseName: "preview"})

	require.NoError(t, err)
	require.NotContains(t, string(out), "kubeport.io/release-uid")
}

func TestRender_ValidatesMin(t *testing.T) {
	values, _ := json.Marshal(map[string]any{
		"Deployment[web].spec.replicas": 0,
	})
	_, err := template.Render(resourcesYAML, uiSpecYAML, values, template.Labels{})
	require.ErrorContains(t, err, "min")
}

func TestRender_IndexOutOfRangeReturnsError(t *testing.T) {
	uiSpec := `fields:
  - path: Deployment[web].spec.template.spec.containers[99].image
    label: "Container Image"
    type: string
`
	values, _ := json.Marshal(map[string]any{
		"Deployment[web].spec.template.spec.containers[99].image": "x",
	})
	_, err := template.Render(resourcesYAML, uiSpec, values, template.Labels{})
	require.ErrorContains(t, err, "out of range")
}

func TestValidateSpec_AcceptsRequiredFieldsWithoutValues(t *testing.T) {
	uiSpec := `fields:
  - path: Deployment[web].spec.replicas
    label: "Replicas"
    type: integer
    required: true
`
	require.NoError(t, template.ValidateSpec(resourcesYAML, uiSpec))
}

func TestValidateSpec_RejectsMalformedUISpec(t *testing.T) {
	require.Error(t, template.ValidateSpec(resourcesYAML, "fields: [invalid"))
}

func TestRender_MissingIntermediateArrayFails(t *testing.T) {
	uiSpec := `fields:
  - path: Deployment[web].spec.annotations[0]
    label: "Annotation"
    type: string
`
	values, _ := json.Marshal(map[string]any{
		"Deployment[web].spec.annotations[0]": "x",
	})
	_, err := template.Render(resourcesYAML, uiSpec, values, template.Labels{})
	require.ErrorContains(t, err, "cannot auto-create array")
}

func TestRender_BooleanType(t *testing.T) {
	uiSpec := `fields:
  - path: Deployment[web].spec.paused
    label: "Paused"
    type: boolean
`
	t.Run("bool ok", func(t *testing.T) {
		values, _ := json.Marshal(map[string]any{
			"Deployment[web].spec.paused": true,
		})
		_, err := template.Render(resourcesYAML, uiSpec, values, template.Labels{})
		require.NoError(t, err)
	})
	t.Run("string rejected", func(t *testing.T) {
		values, _ := json.Marshal(map[string]any{
			"Deployment[web].spec.paused": "yes",
		})
		_, err := template.Render(resourcesYAML, uiSpec, values, template.Labels{})
		require.ErrorContains(t, err, "not a boolean")
	})
}

func TestParseSpec_RejectsInvalidPatternEagerly(t *testing.T) {
	uiSpec := `fields:
  - path: Deployment[web].metadata.name
    label: "Name"
    type: string
    pattern: "["
`
	require.Error(t, template.ValidateSpec(resourcesYAML, uiSpec))
}

func TestRender_StampsPodTemplateLabels(t *testing.T) {
	values, _ := json.Marshal(map[string]any{})
	out, err := template.Render(resourcesYAML, uiSpecYAML, values, template.Labels{
		ReleaseName: "my-api", TemplateName: "web", TemplateVersion: 1,
		ReleaseID: "rel_abc", AppliedBy: "alice@example.com",
	})
	require.NoError(t, err)

	var docs []map[string]any
	dec := yaml.NewDecoder(bytes.NewReader(out))
	for {
		m := map[string]any{}
		if err := dec.Decode(&m); err != nil {
			break
		}
		docs = append(docs, m)
	}
	require.Len(t, docs, 2)

	// Deployment: pod template labels must carry release label for status queries.
	dep := docs[0]
	tmplMeta := dep["spec"].(map[string]any)["template"].(map[string]any)["metadata"].(map[string]any)
	tmplLbls := tmplMeta["labels"].(map[string]any)
	require.Equal(t, "my-api", tmplLbls["kubeport.io/release"])
	require.Equal(t, "web", tmplLbls["kubeport.io/template"])
	require.Equal(t, "true", tmplLbls["kubeport.io/managed"])

	// Service: no spec.template, must not panic, top-level labels still stamped.
	svc := docs[1]
	svcLbls := svc["metadata"].(map[string]any)["labels"].(map[string]any)
	require.Equal(t, "my-api", svcLbls["kubeport.io/release"])
	_, hasTemplate := svc["spec"].(map[string]any)["template"]
	require.False(t, hasTemplate)
}

const cronJobYAML = `
apiVersion: batch/v1
kind: CronJob
metadata: { name: nightly }
spec:
  schedule: "0 0 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: app
              image: busybox
          restartPolicy: OnFailure
`

func TestRender_StampsCronJobPodTemplateLabels(t *testing.T) {
	out, err := template.Render(cronJobYAML, "fields: []\n", []byte(`{}`), template.Labels{
		ReleaseName: "nightly-rel", TemplateName: "cron", TemplateVersion: 1,
	})
	require.NoError(t, err)

	var doc map[string]any
	require.NoError(t, yaml.NewDecoder(bytes.NewReader(out)).Decode(&doc))

	// Nested pod template under spec.jobTemplate.spec.template.metadata.labels
	podMeta := doc["spec"].(map[string]any)["jobTemplate"].(map[string]any)["spec"].(map[string]any)["template"].(map[string]any)["metadata"].(map[string]any)
	require.Equal(t, "nightly-rel", podMeta["labels"].(map[string]any)["kubeport.io/release"])

	// Top-level CronJob labels still stamped.
	require.Equal(t, "nightly-rel", doc["metadata"].(map[string]any)["labels"].(map[string]any)["kubeport.io/release"])
}

const configMapYAML = `
apiVersion: v1
kind: ConfigMap
metadata: { name: conf }
data:
  key: value
`

func TestRender_NoSpecResourceDoesNotPanic(t *testing.T) {
	out, err := template.Render(configMapYAML, "fields: []\n", []byte(`{}`), template.Labels{
		ReleaseName: "c", TemplateName: "conf", TemplateVersion: 1,
	})
	require.NoError(t, err)
	var doc map[string]any
	require.NoError(t, yaml.NewDecoder(bytes.NewReader(out)).Decode(&doc))
	lbls := doc["metadata"].(map[string]any)["labels"].(map[string]any)
	require.Equal(t, "c", lbls["kubeport.io/release"])
}

func TestRender_PatternValidation(t *testing.T) {
	uiSpec := `fields:
  - path: Deployment[web].metadata.name
    label: "Name"
    type: string
    pattern: "^[a-z][a-z0-9-]*$"
`
	t.Run("matching", func(t *testing.T) {
		values, _ := json.Marshal(map[string]any{
			"Deployment[web].metadata.name": "valid-name",
		})
		_, err := template.Render(resourcesYAML, uiSpec, values, template.Labels{})
		require.NoError(t, err)
	})
	t.Run("non-matching", func(t *testing.T) {
		values, _ := json.Marshal(map[string]any{
			"Deployment[web].metadata.name": "Invalid Name 123",
		})
		_, err := template.Render(resourcesYAML, uiSpec, values, template.Labels{})
		require.ErrorContains(t, err, "pattern")
	})
}

// TestRender_AutocompleteType verifies that `type: autocomplete` accepts
// values OUTSIDE the suggestions list (unlike enum, which rejects). This is
// the whole point of autocomplete — recommended options + free input.
func TestRender_AutocompleteType(t *testing.T) {
	uiSpec := `fields:
  - path: Deployment[web].spec.template.spec.containers[0].image
    label: "Image"
    type: autocomplete
    values: ["nginx:1.25", "nginx:1.27", "httpd:2.4"]
`
	t.Run("suggested value works", func(t *testing.T) {
		values, _ := json.Marshal(map[string]any{
			"Deployment[web].spec.template.spec.containers[0].image": "nginx:1.27",
		})
		_, err := template.Render(resourcesYAML, uiSpec, values, template.Labels{})
		require.NoError(t, err)
	})
	t.Run("non-suggested value also works (free input)", func(t *testing.T) {
		values, _ := json.Marshal(map[string]any{
			"Deployment[web].spec.template.spec.containers[0].image": "ghcr.io/internal/custom:v9",
		})
		_, err := template.Render(resourcesYAML, uiSpec, values, template.Labels{})
		require.NoError(t, err, "autocomplete must NOT enforce values")
	})
}

// TestRender_AutocompleteHonorsPattern: pattern still applies to autocomplete
// fields, same as plain string. Catches accidental "autocomplete bypasses
// validation" regression.
func TestRender_AutocompleteHonorsPattern(t *testing.T) {
	uiSpec := `fields:
  - path: Deployment[web].metadata.name
    label: "Name"
    type: autocomplete
    pattern: "^[a-z]+$"
    values: ["api", "web"]
`
	t.Run("matching free value", func(t *testing.T) {
		values, _ := json.Marshal(map[string]any{
			"Deployment[web].metadata.name": "worker",
		})
		_, err := template.Render(resourcesYAML, uiSpec, values, template.Labels{})
		require.NoError(t, err)
	})
	t.Run("non-matching value rejected", func(t *testing.T) {
		values, _ := json.Marshal(map[string]any{
			"Deployment[web].metadata.name": "BadName",
		})
		_, err := template.Render(resourcesYAML, uiSpec, values, template.Labels{})
		require.ErrorContains(t, err, "pattern")
	})
}
