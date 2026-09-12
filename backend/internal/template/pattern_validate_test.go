package template_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/template"
)

func patternSpec(typ, pattern string) string {
	quoted, _ := json.Marshal(pattern)
	return "fields:\n  - path: Deployment[web].metadata.name\n    label: name\n    type: " + typ + "\n    pattern: " + string(quoted) + "\n"
}

// #189: `(?i)` compiles in Go, so the save used to succeed, while the browser
// could not compile it and the form quietly ran without it — the user found
// out from a 400 on deploy. The save is where the admin can still fix it.
func TestValidateSpec_RefusesAPatternTheBrowserReadsDifferently(t *testing.T) {
	for _, typ := range []string{"string", "autocomplete"} {
		t.Run(typ, func(t *testing.T) {
			err := template.ValidateSpec(fieldTypeResources, patternSpec(typ, `(?i)^web-`))

			require.Error(t, err)
			require.Contains(t, err.Error(), "fields[0]")
			require.Contains(t, err.Error(), "unusable pattern")
			require.Contains(t, err.Error(), "(?i")
		})
	}
}

// #187: the form checks the pattern on every keystroke. The message names the
// label like its neighbours, the part to rewrite, and how to rewrite it.
func TestValidateSpec_RefusesANestedRepeat(t *testing.T) {
	err := template.ValidateSpec(fieldTypeResources, patternSpec("string", `^x(a+)+$`))

	require.Error(t, err)
	require.Contains(t, err.Error(), `fields[0] (label "name", path `+"`Deployment[web].metadata.name`)")
	require.Contains(t, err.Error(), "unusable pattern")
	require.Contains(t, err.Error(), "in `(a+)+`")
	require.Contains(t, err.Error(), "`^[a-z]+(-[a-z]+)*$`")
}

func TestValidateSpec_SuggestsListingCharactersForUnicodeClasses(t *testing.T) {
	err := template.ValidateSpec(fieldTypeResources, patternSpec("string", `^\pL+$`))

	require.Error(t, err)
	require.Contains(t, err.Error(), "`[a-zA-Z]`")
}

func TestValidateSpec_RefusesAnOverlongPattern(t *testing.T) {
	err := template.ValidateSpec(fieldTypeResources, patternSpec("string", strings.Repeat("a", 201)))

	require.Error(t, err)
	require.Contains(t, err.Error(), "longer than 200 characters")
}

func TestValidateSpec_AcceptsAnOrdinaryPattern(t *testing.T) {
	require.NoError(t, template.ValidateSpec(fieldTypeResources, patternSpec("string", `^[a-z]+(?:-[a-z]+)*$`)))
}

// A version saved before these rules must still deploy: the rules gate the
// save, and Render keeps checking values with Go's own engine.
func TestRender_StillHonoursAPatternSavedBeforeTheRules(t *testing.T) {
	spec := patternSpec("string", `(?i)^web-`)

	_, err := template.Render(fieldTypeResources, spec, []byte(`{"Deployment[web].metadata.name":"WEB-1"}`), template.Labels{ReleaseName: "r"})
	require.NoError(t, err)

	_, err = template.Render(fieldTypeResources, spec, []byte(`{"Deployment[web].metadata.name":"api"}`), template.Labels{ReleaseName: "r"})
	require.ErrorContains(t, err, "does not match pattern")
}
