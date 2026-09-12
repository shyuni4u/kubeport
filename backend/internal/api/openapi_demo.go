package api

import (
	"encoding/json"
	"strings"
)

// demoOpenAPIGroupVersions is what a demo account may read of a cluster's
// OpenAPI surface (#124): exactly the group/versions the demo RBAC grants —
// deploy/helm/kubeport/templates/demo-rbac.yaml lists "" (core), apps, batch
// and authorization.k8s.io, all at v1.
//
// Why a list rather than "the demo cluster only": on the live install the demo
// cluster IS the production cluster, so a cluster predicate restricts nothing.
// The demo password is on the landing page, which makes "any authenticated
// caller" effectively anyone — and without this they could enumerate every
// group/version and every installed CRD of that cluster. The kind autocomplete
// in the editor still works for everything a demo account can deploy.
// openapi_demo_internal_test.go fails if demo-rbac.yaml grows a group this list
// does not cover.
var demoOpenAPIGroupVersions = map[string]bool{
	"v1":                      true,
	"apps/v1":                 true,
	"batch/v1":                true,
	"authorization.k8s.io/v1": true,
}

// demoAllowsGroupVersion reports whether a demo caller may read gv ("v1",
// "apps/v1", …). gv has already passed openapiUpstreamSegments validation.
func demoAllowsGroupVersion(gv string) bool {
	return demoOpenAPIGroupVersions[gv]
}

// indexPathGroupVersion maps an OpenAPI v3 index key to the gv the proxy's
// /openapi/:gv route takes — the same mapping frontend/lib/openapi.ts
// parseIndex applies: "api/v1" → "v1", "apis/<group>/<version>" →
// "<group>/<version>". Anything else ("version", "api", …) is not a gv.
func indexPathGroupVersion(p string) (string, bool) {
	switch {
	case p == "api/v1":
		return "v1", true
	case strings.HasPrefix(p, "apis/"):
		gv := strings.TrimPrefix(p, "apis/")
		if strings.Count(gv, "/") != 1 {
			return "", false
		}
		return gv, true
	default:
		return "", false
	}
}

// filterOpenAPIIndexForDemo keeps only the index entries a demo caller may
// read. Every other top-level field and each kept entry's value
// (serverRelativeURL) pass through untouched. A body that is not an index —
// no "paths" object — is an error rather than something to pass through
// unfiltered.
func filterOpenAPIIndexForDemo(body []byte) ([]byte, error) {
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, err
	}
	var paths map[string]json.RawMessage
	if err := json.Unmarshal(doc["paths"], &paths); err != nil || paths == nil {
		return nil, errOpenAPIIndexShape
	}
	kept := make(map[string]json.RawMessage, len(demoOpenAPIGroupVersions))
	for p, v := range paths {
		if gv, ok := indexPathGroupVersion(p); ok && demoAllowsGroupVersion(gv) {
			kept[p] = v
		}
	}
	raw, err := json.Marshal(kept)
	if err != nil {
		return nil, err
	}
	doc["paths"] = raw
	return json.Marshal(doc)
}

var errOpenAPIIndexShape = jsonShapeError("OpenAPI index has no paths object")

type jsonShapeError string

func (e jsonShapeError) Error() string { return string(e) }
