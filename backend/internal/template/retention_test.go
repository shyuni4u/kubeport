package template_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"testing"

	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"

	"kubeport/internal/template"
)

// Issue #340. The claims a StatefulSet's controller creates carry no release
// label, so a release's delete left them behind and a later release under the
// same name mounted the earlier one's data. Render defaults the StatefulSet's
// claim retention to Delete, which a template can still override.

const statefulSetWithClaims = `
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
    - metadata: { name: data }
      spec:
        accessModes: [ReadWriteOnce]
        resources: { requests: { storage: 1Gi } }
`

func renderRetention(t *testing.T, resources, uiSpec, values string, l template.Labels) map[string]map[string]any {
	t.Helper()
	out, err := template.Render(resources, uiSpec, json.RawMessage(values), l)
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
		docs[at(t, d, "metadata", "name").(string)] = d
	}
	return docs
}

func TestRender_AStatefulSetsClaimsGoWithTheRelease(t *testing.T) {
	cases := []struct {
		name, uiSpec, object string
		labels               template.Labels
	}{
		{"single", "fields: []\n", "db",
			template.Labels{ReleaseName: "rel", ReleaseID: "id-rel", Namespace: "demo"}},
		{"multiple", "instances: multiple\nfields: []\n", "rel-db",
			template.Labels{ReleaseName: "rel", ReleaseID: "id-rel", Namespace: "demo"}},
		// A preview renders with no release id, and shows what a deploy applies.
		{"single preview", "fields: []\n", "db", template.Labels{ReleaseName: "rel"}},
		{"multiple preview", "instances: multiple\nfields: []\n", "rel-db", template.Labels{ReleaseName: "rel"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sts := renderRetention(t, statefulSetWithClaims, tc.uiSpec, `{}`, tc.labels)[tc.object]
			require.NotNil(t, sts, "rendered objects are named %q", tc.object)
			require.Equal(t, map[string]any{"whenDeleted": "Delete"},
				at(t, sts, "spec", "persistentVolumeClaimRetentionPolicy"),
				"whenScaled stays unset: scaling down is not the release going away")
		})
	}
}

func TestRender_KeepsTheClaimRetentionATemplateWrites(t *testing.T) {
	l := template.Labels{ReleaseName: "rel", ReleaseID: "x"}

	retain := statefulSetWithClaims + "  persistentVolumeClaimRetentionPolicy: { whenDeleted: Retain }\n"
	sts := renderRetention(t, retain, "fields: []\n", `{}`, l)["db"]
	require.Equal(t, map[string]any{"whenDeleted": "Retain"}, at(t, sts, "spec", "persistentVolumeClaimRetentionPolicy"))

	scaledOnly := statefulSetWithClaims + "  persistentVolumeClaimRetentionPolicy: { whenScaled: Delete }\n"
	sts = renderRetention(t, scaledOnly, "fields: []\n", `{}`, l)["db"]
	require.Equal(t, map[string]any{"whenScaled": "Delete", "whenDeleted": "Delete"},
		at(t, sts, "spec", "persistentVolumeClaimRetentionPolicy"),
		"a policy that says nothing about delete still gets the default for it")

	blank := statefulSetWithClaims + "  persistentVolumeClaimRetentionPolicy: { whenDeleted: }\n"
	sts = renderRetention(t, blank, "fields: []\n", `{}`, l)["db"]
	require.Equal(t, "Delete", at(t, sts, "spec", "persistentVolumeClaimRetentionPolicy", "whenDeleted"),
		"a key with no value is the apiserver's default, which is the leak")
}

func TestRender_KeepsAClaimRetentionTheFormSets(t *testing.T) {
	uiSpec := `
fields:
  - path: StatefulSet[db].spec.persistentVolumeClaimRetentionPolicy.whenDeleted
    label: "릴리스 삭제 시 데이터"
    type: enum
    values: [Retain, Delete]
    default: Delete
`
	l := template.Labels{ReleaseName: "rel", ReleaseID: "x"}
	values := `{"StatefulSet[db].spec.persistentVolumeClaimRetentionPolicy.whenDeleted":"Retain"}`
	sts := renderRetention(t, statefulSetWithClaims, uiSpec, values, l)["db"]
	require.Equal(t, "Retain", at(t, sts, "spec", "persistentVolumeClaimRetentionPolicy", "whenDeleted"))
}

func TestRender_LeavesClaimRetentionOffEverythingElse(t *testing.T) {
	resources := `
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: cache }
spec:
  serviceName: cache
  selector: { matchLabels: { app: cache } }
  template:
    metadata: { labels: { app: cache } }
    spec: { containers: [{ name: cache, image: redis }] }
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: empty }
spec:
  serviceName: empty
  selector: { matchLabels: { app: empty } }
  template:
    metadata: { labels: { app: empty } }
    spec: { containers: [{ name: empty, image: redis }] }
  volumeClaimTemplates: []
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec: { containers: [{ name: web, image: nginx }] }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: shared }
spec: { accessModes: [ReadWriteOnce], resources: { requests: { storage: 1Gi } } }
`
	docs := renderRetention(t, resources, "fields: []\n", `{}`, template.Labels{ReleaseName: "rel", ReleaseID: "x"})
	require.Len(t, docs, 4)
	for name, d := range docs {
		spec, _ := d["spec"].(map[string]any)
		require.NotContains(t, spec, "persistentVolumeClaimRetentionPolicy", name)
	}
}
