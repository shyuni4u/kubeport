package api_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/template"
)

// Issue #281: saving a template with more objects than a release can apply
// inside the apply lock's hold is refused with the reason, so the author finds
// out now rather than a user finding out at deploy.
func TestCreateTemplate_RefusesMoreObjectsThanAReleaseCanApply(t *testing.T) {
	r := newTestRouterAdmin(t)
	var b strings.Builder
	b.WriteString(minimalResources)
	for i := 0; i < template.MaxObjects; i++ {
		fmt.Fprintf(&b, "---\napiVersion: v1\nkind: ConfigMap\nmetadata: { name: cm-%d }\n", i)
	}
	body, _ := json.Marshal(map[string]any{
		"name": "too-many-" + randSuffix(), "display_name": "Too many objects", "authoring_mode": "yaml",
		"resources_yaml": b.String(), "ui_spec_yaml": minimalUISpec,
	})

	w := do(t, r, http.MethodPost, "/v1/templates", bytes.NewReader(body))
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	p := problemShape(t, w.Body.String())
	require.Equal(t, "validation-error", p.Title)
	require.Contains(t, p.Detail, fmt.Sprintf("more than %d objects", template.MaxObjects))
}
