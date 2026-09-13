package template

import (
	"fmt"
	"strings"
)

// DemoPolicy is what a demo account's rendered manifest must keep to (#350).
// The demo's accounts are shared by every visitor and reach the cluster only
// through kubeport, so the API holds their releases to limits that bound what
// one visitor leaves on the single node: finished Job pods (their writable
// layers and logs stay on disk until the pod is deleted) and the images pulled
// for them.
//
// A nil limit, or an empty prefix list, turns that rule off. A self-hosted
// install without demo mode never builds one.
type DemoPolicy struct {
	// JobBackoffLimit caps backoffLimit on a Job and on a CronJob's job
	// template. Each retry of a Job whose pods never restart leaves another
	// failed pod behind.
	JobBackoffLimit *int64
	// JobTTLSecondsAfterFinished caps ttlSecondsAfterFinished on a Job applied
	// on its own. A CronJob's jobs are bounded by its history limits instead, so
	// a job the demo shows failing on purpose stays visible until the next reset.
	JobTTLSecondsAfterFinished *int64
	// CronJobHistoryLimit caps successfulJobsHistoryLimit and
	// failedJobsHistoryLimit on a CronJob: how many finished jobs, and so pods,
	// it keeps.
	CronJobHistoryLimit *int64
	// ImagePrefixes, when not empty, are the image references a demo pod may
	// use: container, init container and image volume images. Compared after
	// normalizing both sides (normalizeImage, normalizePrefix).
	ImagePrefixes []string
}

// Enabled reports whether any rule is on.
func (p DemoPolicy) Enabled() bool {
	return p.JobBackoffLimit != nil || p.JobTTLSecondsAfterFinished != nil ||
		p.CronJobHistoryLimit != nil || len(p.ImagePrefixes) > 0
}

// DemoViolation is one place a manifest breaks a DemoPolicy.
type DemoViolation struct {
	// Rule is one of "job-backoff-limit", "job-ttl", "cronjob-history-limit"
	// and "image-prefix".
	Rule      string
	Kind      string
	Name      string
	Container string // image-prefix only
	Field     string // path within the object, e.g. spec.backoffLimit
	Limit     *int64 // the cap, for the numeric rules
	Got       any    // the value the manifest holds
}

// ApplyDemoPolicy holds a rendered manifest to p.
//
// A numeric limit the manifest leaves unset is filled with the limit, and one it
// sets above the limit is a violation. Filling rather than refusing an unset
// value is what keeps the demo's own seed working: the reset seeds its releases
// through the API as the demo user, from templates that set neither field, and
// refusing them would leave the demo wiped and unseeded (#105). Refusing rather
// than lowering a value that is set keeps what a template or a visitor wrote
// from being changed behind their back.
//
// An image outside ImagePrefixes is a violation. With every rule off the input
// comes back unchanged, byte for byte; otherwise the documents are re-encoded,
// as Render encodes them.
func ApplyDemoPolicy(rendered []byte, p DemoPolicy) ([]byte, []DemoViolation, error) {
	if !p.Enabled() {
		return rendered, nil, nil
	}
	docs, err := parseMultiDoc(string(rendered))
	if err != nil {
		return nil, nil, fmt.Errorf("demo policy: %w", err)
	}
	prefixes := make([]string, 0, len(p.ImagePrefixes))
	for _, prefix := range p.ImagePrefixes {
		prefixes = append(prefixes, normalizePrefix(prefix))
	}

	var violations []DemoViolation
	for _, d := range docs {
		kind, _ := d["kind"].(string)
		name := objectName(d)
		limit := func(m map[string]any, key, path, rule string, max *int64) {
			if v, ok := capInt(m, key, max); !ok {
				violations = append(violations, DemoViolation{Rule: rule, Kind: kind, Name: name, Field: path, Limit: max, Got: v})
			}
		}
		spec := mapAt(d, "spec")
		var podSpec map[string]any
		podPath := "spec.template.spec"
		// backoffLimit bounds a Job's failed pods only while every failure
		// counts toward it (security review). A podFailurePolicy rule that
		// ignores a failure retries past it, and so does a limit per index, so
		// with the backoff rule on the first is refused and the second is held
		// to the same limit. Neither is filled: a Job without them is bounded.
		jobFailures := func(jobSpec map[string]any, path string) {
			if p.JobBackoffLimit == nil || jobSpec == nil {
				return
			}
			if v, set := jobSpec["backoffLimitPerIndex"]; set && v != nil {
				limit(jobSpec, "backoffLimitPerIndex", path+".backoffLimitPerIndex", "job-backoff-limit", p.JobBackoffLimit)
			}
			policy := mapAt(jobSpec, "podFailurePolicy")
			if policy == nil {
				return
			}
			for i, rule := range mapsIn(policy, "rules") {
				if action, _ := rule["action"].(string); action == "Ignore" {
					violations = append(violations, DemoViolation{
						Rule: "job-backoff-limit", Kind: kind, Name: name,
						Field: fmt.Sprintf("%s.podFailurePolicy.rules[%d].action", path, i), Got: action,
					})
				}
			}
		}
		switch kind {
		case "Job":
			limit(spec, "backoffLimit", "spec.backoffLimit", "job-backoff-limit", p.JobBackoffLimit)
			jobFailures(spec, "spec")
			limit(spec, "ttlSecondsAfterFinished", "spec.ttlSecondsAfterFinished", "job-ttl", p.JobTTLSecondsAfterFinished)
			podSpec = mapAt(spec, "template", "spec")
		case "CronJob":
			limit(spec, "successfulJobsHistoryLimit", "spec.successfulJobsHistoryLimit", "cronjob-history-limit", p.CronJobHistoryLimit)
			limit(spec, "failedJobsHistoryLimit", "spec.failedJobsHistoryLimit", "cronjob-history-limit", p.CronJobHistoryLimit)
			limit(mapAt(spec, "jobTemplate", "spec"), "backoffLimit", "spec.jobTemplate.spec.backoffLimit", "job-backoff-limit", p.JobBackoffLimit)
			jobFailures(mapAt(spec, "jobTemplate", "spec"), "spec.jobTemplate.spec")
			podSpec = mapAt(spec, "jobTemplate", "spec", "template", "spec")
			podPath = "spec.jobTemplate.spec.template.spec"
		case "Pod":
			podSpec = spec
			podPath = "spec"
		default:
			// Any other kind with a pod template — Deployment, StatefulSet,
			// DaemonSet, and ReplicaSet, which the demo roles may create too
			// (codex review). Listing kinds would let the next one through.
			podSpec = mapAt(spec, "template", "spec")
		}
		if len(prefixes) == 0 || podSpec == nil {
			continue
		}
		for _, key := range []string{"initContainers", "containers"} {
			for i, c := range mapsIn(podSpec, key) {
				image, ok := c["image"].(string)
				if !ok || imageAllowed(normalizeImage(image), prefixes) {
					continue
				}
				container, _ := c["name"].(string)
				violations = append(violations, DemoViolation{
					Rule: "image-prefix", Kind: kind, Name: name, Container: container,
					Field: fmt.Sprintf("%s.%s[%d].image", podPath, key, i), Got: image,
				})
			}
		}
		// An image volume pulls an image as surely as a container does
		// (security review).
		for i, v := range mapsIn(podSpec, "volumes") {
			ref, ok := mapAt(v, "image")["reference"].(string)
			if !ok || imageAllowed(normalizeImage(ref), prefixes) {
				continue
			}
			violations = append(violations, DemoViolation{
				Rule: "image-prefix", Kind: kind, Name: name,
				Field: fmt.Sprintf("%s.volumes[%d].image.reference", podPath, i), Got: ref,
			})
		}
	}
	if len(violations) > 0 {
		return nil, violations, nil
	}
	out, err := marshalMultiDoc(docs)
	if err != nil {
		return nil, nil, fmt.Errorf("demo policy: %w", err)
	}
	return out, nil, nil
}

// capInt fills m[key] with max when it is unset and reports false when it is
// set above max, returning what it held. A value that is not a number is left
// for the apiserver to refuse. A nil max, or a missing m, does nothing.
func capInt(m map[string]any, key string, max *int64) (any, bool) {
	if max == nil || m == nil {
		return nil, true
	}
	v, set := m[key]
	if !set || v == nil {
		m[key] = *max
		return nil, true
	}
	var n int64
	switch x := v.(type) {
	case int:
		n = int64(x)
	case int64:
		n = x
	case uint64:
		if x > uint64(*max) {
			return v, false
		}
		return v, true
	case float64:
		if x > float64(*max) {
			return v, false
		}
		return v, true
	default:
		return v, true
	}
	return v, n <= *max
}

// normalizeImage writes an image reference the way the container runtime reads
// it, so a prefix matches however the reference was spelled: a reference with
// no registry is Docker Hub's, index.docker.io is Docker Hub too, and a Docker
// Hub name with no namespace is in its library namespace. busybox:1.36,
// docker.io/busybox:1.36 and index.docker.io/library/busybox:1.36 are all
// docker.io/library/busybox:1.36; nginx/nginx is docker.io/nginx/nginx. The
// first path segment is a registry when it holds a "." or ":" or is
// "localhost", and a registry's name is case-insensitive.
//
// Prefixes go through it too, so "docker.io/" stays all of Docker Hub: only a
// non-empty name gains library/.
func normalizeImage(ref string) string {
	ref = strings.TrimSpace(ref)
	registry, rest, hasSlash := strings.Cut(ref, "/")
	if !hasSlash || !(strings.ContainsAny(registry, ".:") || registry == "localhost") {
		registry, rest = "docker.io", ref
	}
	registry = strings.ToLower(registry)
	if registry == "index.docker.io" {
		registry = "docker.io"
	}
	if registry == "docker.io" && rest != "" && !strings.Contains(rest, "/") {
		rest = "library/" + rest
	}
	return registry + "/" + rest
}

// normalizePrefix is normalizeImage for an allowed prefix, except that a
// registry on its own — ghcr.io, registry.example.com:5000, localhost:5000 —
// means every image from that registry rather than a Docker Hub library image
// of that name (master review). Without a "/" it is a registry when the part
// before any ":" holds a "." or is "localhost"; busybox:1.36 is still an image.
func normalizePrefix(prefix string) string {
	prefix = strings.TrimSpace(prefix)
	host, _, _ := strings.Cut(prefix, ":")
	if strings.Contains(prefix, "/") || !(strings.Contains(host, ".") || host == "localhost") {
		return normalizeImage(prefix)
	}
	registry := strings.ToLower(prefix)
	if registry == "index.docker.io" {
		registry = "docker.io"
	}
	return registry + "/"
}

// imageAllowed reports whether image starts with one of prefixes at a boundary.
// A prefix that ends in "/" or ":" matches anything after it; any other prefix
// must be followed by the end of the reference, a tag, a digest or a path, so
// docker.io/library/busybox does not admit docker.io/library/busybox-evil.
func imageAllowed(image string, prefixes []string) bool {
	for _, p := range prefixes {
		if !strings.HasPrefix(image, p) {
			continue
		}
		if len(image) == len(p) || strings.HasSuffix(p, "/") || strings.HasSuffix(p, ":") {
			return true
		}
		switch image[len(p)] {
		case ':', '@', '/':
			return true
		}
	}
	return false
}
