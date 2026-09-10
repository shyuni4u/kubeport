package template_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/template"
)

const reservedResources = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1
`

func specExposing(path string) string {
	return "fields:\n  - path: " + path + "\n    label: \"x\"\n    type: string\n"
}

// #137: a value at these paths comes from whoever deploys, and each one breaks
// something kubeport assumes about a release's objects.
func TestValidateSpec_RejectsPathsKubeportDecides(t *testing.T) {
	for _, path := range []string{
		"Deployment[web].metadata.namespace",
		"Deployment[web].metadata",
		"Deployment[web].kind",
		"Deployment[web].apiVersion",
	} {
		t.Run(path, func(t *testing.T) {
			err := template.ValidateSpec(reservedResources, specExposing(path))
			require.Error(t, err)
			require.Contains(t, err.Error(), "which kubeport decides")
		})
	}
}

// Exposing the name is how a template lets two releases share a namespace, and
// the deploy-time ownership check is what keeps that safe. It has to stay
// allowed, along with everything else under metadata.
func TestValidateSpec_AllowsMetadataNameAndLabels(t *testing.T) {
	for _, path := range []string{
		"Deployment[web].metadata.name",
		"Deployment[web].metadata.labels.team",
		"Deployment[web].spec.replicas",
	} {
		t.Run(path, func(t *testing.T) {
			require.NoError(t, template.ValidateSpec(reservedResources, specExposing(path)))
		})
	}
}
