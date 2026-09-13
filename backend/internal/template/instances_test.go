package template_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"

	"kubeport/internal/template"
)

// Issue #190. A template whose objects have fixed names holds one release per
// namespace. instances: multiple names every object after its release, points
// the template's own references at the new names, and adds the release label to
// selectors so two releases do not share traffic or pods.

const multiResources = `
apiVersion: v1
kind: ConfigMap
metadata: { name: app-config }
data: { REGION: kr }
---
apiVersion: v1
kind: Secret
metadata: { name: app-secret }
stringData: { API_KEY: x }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
  annotations: { example.com/reads-from: app-config }
spec:
  selector: { matchLabels: { app: app } }
  template:
    metadata: { labels: { app: app } }
    spec:
      imagePullSecrets: [{ name: registry-cred }]
      volumes:
        - name: conf
          configMap: { name: app-config }
        - name: shared
          configMap: { name: cluster-wide }
      containers:
        - name: app
          image: nginx
          args: ["--config-map", "app-config"]
          envFrom:
            - configMapRef: { name: app-config }
            - secretRef: { name: app-secret }
          env:
            - name: KEY
              valueFrom: { secretKeyRef: { name: app-secret, key: API_KEY } }
---
apiVersion: v1
kind: Service
metadata: { name: app }
spec:
  selector: { app: app }
  ports: [{ port: 80 }]
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: app }
spec:
  tls: [{ secretName: app-secret }]
  rules:
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend: { service: { name: app, port: { number: 80 } } }
`

func renderByKind(t *testing.T, spec, release string) map[string]map[string]any {
	t.Helper()
	out, err := template.Render(multiResources, spec, json.RawMessage(`{}`), template.Labels{
		ReleaseName: release, TemplateName: "app", TemplateVersion: 1, ReleaseID: "id-" + release,
	})
	require.NoError(t, err)
	docs := map[string]map[string]any{}
	dec := yaml.NewDecoder(bytes.NewReader(out))
	for {
		var d map[string]any
		err := dec.Decode(&d)
		if errors.Is(err, io.EOF) {
			break
		}
		require.NoError(t, err)
		docs[d["kind"].(string)] = d
	}
	return docs
}

func at(t *testing.T, v any, path ...any) any {
	t.Helper()
	for _, p := range path {
		switch k := p.(type) {
		case string:
			m, ok := v.(map[string]any)
			require.Truef(t, ok, "expected a map at %v", p)
			v = m[k]
		case int:
			l, ok := v.([]any)
			require.Truef(t, ok, "expected a list at %v", p)
			v = l[k]
		}
	}
	return v
}

func TestRender_MultipleInstancesNamesEveryObjectAfterTheRelease(t *testing.T) {
	docs := renderByKind(t, "instances: multiple\nfields: []\n", "rel-a")

	for kind, want := range map[string]string{
		"ConfigMap": "rel-a-app-config", "Secret": "rel-a-app-secret",
		"Deployment": "rel-a-app", "Service": "rel-a-app", "Ingress": "rel-a-app",
	} {
		require.Equal(t, want, at(t, docs[kind], "metadata", "name"), kind)
	}

	pod := at(t, docs["Deployment"], "spec", "template", "spec")
	require.Equal(t, "rel-a-app-config", at(t, pod, "volumes", 0, "configMap", "name"))
	require.Equal(t, "cluster-wide", at(t, pod, "volumes", 1, "configMap", "name"),
		"a ConfigMap the template does not declare keeps its name")
	require.Equal(t, "registry-cred", at(t, pod, "imagePullSecrets", 0, "name"),
		"a Secret the template does not declare keeps its name")
	require.Equal(t, "rel-a-app-config", at(t, pod, "containers", 0, "envFrom", 0, "configMapRef", "name"))
	require.Equal(t, "rel-a-app-secret", at(t, pod, "containers", 0, "envFrom", 1, "secretRef", "name"))
	require.Equal(t, "rel-a-app-secret", at(t, pod, "containers", 0, "env", 0, "valueFrom", "secretKeyRef", "name"))

	// Only the closed list of reference fields is rewritten. The same name in a
	// field kubeport does not know as a reference — an argument, an annotation
	// another tool reads — is data, and stays as the template wrote it.
	require.Equal(t, "app-config", at(t, pod, "containers", 0, "args", 1))
	require.Equal(t, "app-config", at(t, docs["Deployment"], "metadata", "annotations", "example.com/reads-from"))

	require.Equal(t, "rel-a-app", at(t, docs["Ingress"], "spec", "rules", 0, "http", "paths", 0, "backend", "service", "name"))
	require.Equal(t, "rel-a-app-secret", at(t, docs["Ingress"], "spec", "tls", 0, "secretName"))

	require.Equal(t, map[string]any{"app": "app", "kubeport.io/release": "rel-a"},
		at(t, docs["Service"], "spec", "selector"))
	require.Equal(t, map[string]any{"app": "app", "kubeport.io/release": "rel-a"},
		at(t, docs["Deployment"], "spec", "selector", "matchLabels"))
	require.Equal(t, "rel-a", at(t, docs["Deployment"], "spec", "template", "metadata", "labels", "kubeport.io/release"),
		"the pods carry what the selector now asks for")
}

// codex review: a claim cloned from another claim of the template must follow
// its source's new name, through dataSource and dataSourceRef. A source the
// template does not declare, or one of another kind, stays as written.
func TestRender_MultipleInstancesRewritesClaimsClonedFromTheTemplatesOwnClaim(t *testing.T) {
	resources := `
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: data }
spec: { accessModes: [ReadWriteOnce], resources: { requests: { storage: 1Gi } } }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: copy }
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 1Gi } }
  dataSource: { kind: PersistentVolumeClaim, name: data }
  dataSourceRef: { kind: PersistentVolumeClaim, name: data }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: restored }
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 1Gi } }
  dataSource: { apiGroup: snapshot.storage.k8s.io, kind: VolumeSnapshot, name: data }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: external }
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 1Gi } }
  dataSource: { kind: PersistentVolumeClaim, name: shared-golden-image }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: elsewhere }
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 1Gi } }
  dataSourceRef: { kind: PersistentVolumeClaim, name: data, namespace: golden-images }
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: db }
spec:
  serviceName: db
  selector: { matchLabels: { app: db } }
  template:
    metadata: { labels: { app: db } }
    spec: { containers: [{ name: db, image: postgres }] }
  volumeClaimTemplates:
    - metadata: { name: pgdata }
      spec:
        accessModes: [ReadWriteOnce]
        resources: { requests: { storage: 1Gi } }
        dataSource: { kind: PersistentVolumeClaim, name: data }
`
	out, err := template.Render(resources, "instances: multiple\nfields: []\n", json.RawMessage(`{}`),
		template.Labels{ReleaseName: "rel", ReleaseID: "x"})
	require.NoError(t, err)
	claims := map[string]map[string]any{}
	dec := yaml.NewDecoder(bytes.NewReader(out))
	for {
		var d map[string]any
		if err := dec.Decode(&d); errors.Is(err, io.EOF) {
			break
		} else {
			require.NoError(t, err)
		}
		claims[at(t, d, "metadata", "name").(string)] = d
	}

	require.Equal(t, "rel-data", at(t, claims["rel-copy"], "spec", "dataSource", "name"))
	require.Equal(t, "rel-data", at(t, claims["rel-copy"], "spec", "dataSourceRef", "name"))
	require.Equal(t, "data", at(t, claims["rel-restored"], "spec", "dataSource", "name"),
		"a VolumeSnapshot named like a claim is another object")
	require.Equal(t, "shared-golden-image", at(t, claims["rel-external"], "spec", "dataSource", "name"),
		"a claim the template does not declare keeps its name")
	require.Equal(t, "data", at(t, claims["rel-elsewhere"], "spec", "dataSourceRef", "name"),
		"a dataSourceRef into another namespace is not the template's claim, even under the same name")

	sts := claims["rel-db"]
	require.Equal(t, "pgdata", at(t, sts, "spec", "volumeClaimTemplates", 0, "metadata", "name"),
		"claim template names are the controller's to expand and stay as written")
	require.Equal(t, "rel-data", at(t, sts, "spec", "volumeClaimTemplates", 0, "spec", "dataSource", "name"),
		"a claim template cloned from the template's own claim follows its new name")
}

// The point of the mode: two releases in one namespace share no object name,
// and neither's selectors match the other's pods.
func TestRender_TwoReleasesOfAMultipleTemplateShareNothing(t *testing.T) {
	a := renderByKind(t, "instances: multiple\nfields: []\n", "rel-a")
	b := renderByKind(t, "instances: multiple\nfields: []\n", "rel-b")

	for kind := range a {
		require.NotEqual(t, at(t, a[kind], "metadata", "name"), at(t, b[kind], "metadata", "name"), kind)
	}
	podLabelsB := at(t, b["Deployment"], "spec", "template", "metadata", "labels").(map[string]any)
	for _, sel := range []map[string]any{
		at(t, a["Service"], "spec", "selector").(map[string]any),
		at(t, a["Deployment"], "spec", "selector", "matchLabels").(map[string]any),
	} {
		matches := true
		for k, v := range sel {
			if podLabelsB[k] != v {
				matches = false
			}
		}
		require.False(t, matches, "rel-a's selector %v must not select rel-b's pods %v", sel, podLabelsB)
	}
}

// Without the key, or with single, a template renders exactly as it did: the
// names and selectors the template wrote.
func TestRender_SingleInstanceIsTheDefaultAndRewritesNothing(t *testing.T) {
	for _, spec := range []string{"fields: []\n", "instances: single\nfields: []\n"} {
		docs := renderByKind(t, spec, "rel-a")
		require.Equal(t, "app", at(t, docs["Deployment"], "metadata", "name"), spec)
		require.Equal(t, "app-config", at(t, docs["Deployment"], "spec", "template", "spec", "volumes", 0, "configMap", "name"), spec)
		require.Equal(t, map[string]any{"app": "app"}, at(t, docs["Service"], "spec", "selector"), spec)
		require.Equal(t, map[string]any{"app": "app"}, at(t, docs["Deployment"], "spec", "selector", "matchLabels"), spec)
	}
}

func TestRender_MultipleInstancesRefusesANameThatWouldBeTooLong(t *testing.T) {
	release := strings.Repeat("r", 55)
	_, err := template.Render(multiResources, "instances: multiple\nfields: []\n", json.RawMessage(`{}`),
		template.Labels{ReleaseName: release, ReleaseID: "x"})
	require.Error(t, err)
	require.Contains(t, err.Error(), "no more than 63 characters")
}

// codex review: a release name the API accepts can still make a name the
// apiserver refuses. A Service name is a DNS-1035 label, so it cannot start
// with a digit or hold a dot; a CronJob's is capped at 52, which leaves room for
// the suffix of the Jobs it creates. Both are refused at render, not at apply.
func TestRender_MultipleInstancesChecksEachKindsNamingRules(t *testing.T) {
	spec := "instances: multiple\nfields: []\n"

	for _, release := range []string{"1demo", "demo.one"} {
		_, err := template.Render(multiResources, spec, json.RawMessage(`{}`), template.Labels{ReleaseName: release, ReleaseID: "x"})
		require.Errorf(t, err, "release %q", release)
		require.Contains(t, err.Error(), "Kubernetes refuses", release)
	}

	cron := "apiVersion: batch/v1\nkind: CronJob\nmetadata: { name: " + strings.Repeat("c", 30) + " }\n" +
		"spec:\n  schedule: \"0 3 * * *\"\n  jobTemplate: { spec: { template: { spec: { restartPolicy: Never, containers: [{ name: job, image: busybox }] } } } }\n"
	require.NoError(t, template.ValidateSpec(cron, spec), "a 30-character name is allowed at save")
	_, err := template.Render(cron, spec, json.RawMessage(`{}`), template.Labels{ReleaseName: strings.Repeat("r", 22), ReleaseID: "x"})
	require.Error(t, err)
	require.Contains(t, err.Error(), "no more than 52 characters")
	require.Contains(t, err.Error(), "at most 21 characters", "the suggested release length follows the CronJob limit")
	_, err = template.Render(cron, spec, json.RawMessage(`{}`), template.Labels{ReleaseName: strings.Repeat("r", 21), ReleaseID: "x"})
	require.NoError(t, err)
}

func TestRender_MultipleInstancesNeedsAReleaseName(t *testing.T) {
	_, err := template.Render(multiResources, "instances: multiple\nfields: []\n", json.RawMessage(`{}`), template.Labels{})
	require.ErrorContains(t, err, "needs a release name")
}

func TestValidateSpec_Instances(t *testing.T) {
	require.NoError(t, template.ValidateSpec(multiResources, "instances: multiple\nfields: []\n"))
	require.NoError(t, template.ValidateSpec(multiResources, "instances: single\nfields: []\n"))

	err := template.ValidateSpec(multiResources, "instances: many\nfields: []\n")
	require.ErrorContains(t, err, `instances is "many"`)

	exposed := "instances: multiple\nfields:\n  - path: Deployment[app].metadata.name\n    label: Name\n    type: string\n"
	require.ErrorContains(t, template.ValidateSpec(multiResources, exposed), "exposes metadata.name")
	require.NoError(t, template.ValidateSpec(multiResources, strings.Replace(exposed, "instances: multiple\n", "", 1)),
		"single templates keep exposing the name, as #161 allows")

	long := "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: " + strings.Repeat("c", 31) + " }\n"
	require.ErrorContains(t, template.ValidateSpec(long, "instances: multiple\nfields: []\n"), "keep object names to 30")
	require.NoError(t, template.ValidateSpec(long, "fields: []\n"))
}
