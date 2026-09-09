package api

import (
	"errors"
	"regexp"
	"strings"
)

// k8s serves OpenAPI v3 under two roots:
//
//	/openapi/v3/api/<version>            — core API (no group)
//	/openapi/v3/apis/<group>/<version>   — named groups
//
// `group` is a DNS subdomain and `version` a DNS-1035 label. Neither may
// contain a slash or a dot-segment, so validating against these two patterns
// is enough to keep the assembled path inside /openapi/v3. The version rule is
// deliberately the full label rule rather than `v1`/`v1beta2` so that
// admin-registered CRDs (v1.1 scope) keep working.
var (
	openapiGroupRe   = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$`)
	openapiVersionRe = regexp.MustCompile(`^[a-z]([-a-z0-9]*[a-z0-9])?$`)
)

const (
	maxOpenAPIGroupLen   = 253 // DNS subdomain
	maxOpenAPIVersionLen = 63  // DNS label
)

var errOpenAPIBadGroupVersion = errors.New("gv must be a group/version pair, e.g. \"v1\" or \"apps/v1\"")

// openapiUpstreamSegments turns a caller-supplied group/version into the path
// segments *below* the cluster's /openapi/v3 root. An empty gv addresses the
// index and yields no extra segments.
//
// The segments are returned individually so the caller hands them to
// url.URL.JoinPath one by one instead of concatenating strings: JoinPath runs
// path.Join over its arguments, so a segment carrying "/" or ".." would
// otherwise collapse out of the intended prefix and turn this endpoint into a
// general-purpose GET proxy against the k8s API, with the caller's OIDC token
// attached (issue #11). Validation here is what keeps that from happening;
// the prefix assertion at the call site is a second line of defence.
func openapiUpstreamSegments(gv string) ([]string, error) {
	if gv == "" {
		return nil, nil
	}
	parts := strings.Split(gv, "/")
	switch len(parts) {
	case 1:
		if !validOpenAPIVersion(parts[0]) {
			return nil, errOpenAPIBadGroupVersion
		}
		return []string{"api", parts[0]}, nil
	case 2:
		if !validOpenAPIGroup(parts[0]) || !validOpenAPIVersion(parts[1]) {
			return nil, errOpenAPIBadGroupVersion
		}
		return []string{"apis", parts[0], parts[1]}, nil
	default:
		return nil, errOpenAPIBadGroupVersion
	}
}

func validOpenAPIGroup(s string) bool {
	return s != "" && len(s) <= maxOpenAPIGroupLen && openapiGroupRe.MatchString(s)
}

func validOpenAPIVersion(s string) bool {
	return s != "" && len(s) <= maxOpenAPIVersionLen && openapiVersionRe.MatchString(s)
}
