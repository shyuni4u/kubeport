package main

import (
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/cmd/seed-demo/fixtures"
	"kubeport/internal/template"
)

func TestFixturesValidate(t *testing.T) {
	all := fixtures.All()
	require.Len(t, all, 3)
	for _, f := range all {
		require.NoError(t, template.ValidateSpec(f.ResourcesYAML, f.UISpecYAML), f.Name)
	}
}

func TestReleaseSpecs(t *testing.T) {
	rs := releaseSpecs()
	require.Len(t, rs, 2)
	require.Equal(t, "web-app-demo", rs[0].Name)
	require.Equal(t, "nightly-job-demo", rs[1].Name)
	require.Contains(t, string(rs[1].Values), "does-not-exist", "second release must fail to pull so the failure UX is visible")
}
