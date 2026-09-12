package template_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/template"
)

// configMaps returns n ConfigMap documents.
func configMaps(n int) string {
	var b strings.Builder
	for i := 0; i < n; i++ {
		fmt.Fprintf(&b, "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: cm-%d }\n---\n", i)
	}
	return b.String()
}

// Issue #281. A release applies its objects under the apply lock's 60s hold,
// at client-go's default rate; past a hundred or so an update could never
// finish. The cap is enforced where the template is saved and again where a
// stored one is rendered.
func TestValidateSpec_RefusesMoreObjectsThanAReleaseCanApply(t *testing.T) {
	require.NoError(t, template.ValidateSpec(configMaps(template.MaxObjects), "fields: []\n"))

	err := template.ValidateSpec(configMaps(template.MaxObjects+1), "fields: []\n")
	require.Error(t, err)
	require.Contains(t, err.Error(), fmt.Sprint(template.MaxObjects))
}

// A version saved before the cap existed is refused when it is deployed, before
// anything reaches the cluster.
func TestRender_RefusesMoreObjectsThanAReleaseCanApply(t *testing.T) {
	_, err := template.Render(configMaps(template.MaxObjects+1), "fields: []\n", json.RawMessage(`{}`), template.Labels{ReleaseName: "r"})
	require.Error(t, err)
	require.Contains(t, err.Error(), "more than")

	out, err := template.Render(configMaps(template.MaxObjects), "fields: []\n", json.RawMessage(`{}`), template.Labels{ReleaseName: "r"})
	require.NoError(t, err)
	require.Equal(t, template.MaxObjects, strings.Count(string(out), "kind: ConfigMap"))
}

// Empty documents — a stray `---` — are not objects and do not count.
func TestValidateSpec_EmptyDocumentsDoNotCountTowardTheCap(t *testing.T) {
	src := configMaps(template.MaxObjects) + strings.Repeat("---\n", 10)
	require.NoError(t, template.ValidateSpec(src, "fields: []\n"))
}
