package main

import (
	"fmt"
	"strings"

	"kubeport/cmd/seed-demo/fixtures"
	"kubeport/internal/template"
)

// checkSeedDemoPolicy renders each seed release from the fixtures this binary
// carries and holds it to the demo policy the backend reads from the same
// environment (#350).
//
// The seed creates its releases through the API as the demo user, so a policy
// that refuses one — an image allowlist without the seed's images, say — used
// to fail the seed only after the reset had emptied the demo, which is #105
// again (master review). In preflight it fails the Job before anything is
// deleted. It needs no I/O.
func checkSeedDemoPolicy(getenv func(string) string, namespace string) error {
	policy, err := template.DemoPolicyFromEnv(getenv)
	if err != nil {
		return err
	}
	if !policy.Enabled() {
		return nil
	}
	byName := map[string]fixtures.Template{}
	for _, f := range fixtures.All() {
		byName[f.Name] = f
	}
	for _, r := range releaseSpecs() {
		f, ok := byName[r.Template]
		if !ok {
			return fmt.Errorf("seed release %s: no fixture for template %s", r.Name, r.Template)
		}
		rendered, err := template.Render(f.ResourcesYAML, f.UISpecYAML, r.Values, template.Labels{
			ReleaseName: r.Name, TemplateName: r.Template, TemplateVersion: 1, ReleaseID: "preflight", Namespace: namespace,
		})
		if err != nil {
			return fmt.Errorf("seed release %s: render: %w", r.Name, err)
		}
		_, violations, err := template.ApplyDemoPolicy(rendered, policy)
		if err != nil {
			return fmt.Errorf("seed release %s: demo policy: %w", r.Name, err)
		}
		if len(violations) > 0 {
			what := make([]string, len(violations))
			for i, v := range violations {
				what[i] = fmt.Sprintf("%s: %s %s %s is %v", v.Rule, v.Kind, v.Name, v.Field, v.Got)
			}
			return fmt.Errorf("seed release %s would be refused by the demo policy (KBP_DEMO_*), so the reset would empty the demo and fail to re-seed it: %s",
				r.Name, strings.Join(what, "; "))
		}
	}
	return nil
}
