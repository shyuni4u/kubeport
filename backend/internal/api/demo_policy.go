package api

import (
	"fmt"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"

	"kubeport/internal/config"
	"kubeport/internal/template"
)

// demoPolicy is template.DemoPolicy, named here so Handlers can hold one.
type demoPolicy = template.DemoPolicy

func demoPolicyFrom(cfg config.Config) demoPolicy {
	return demoPolicy{
		JobBackoffLimit:            cfg.DemoJobBackoffLimit,
		JobTTLSecondsAfterFinished: cfg.DemoJobTTLSecondsAfterFinished,
		CronJobHistoryLimit:        cfg.DemoCronJobHistoryLimit,
		ImagePrefixes:              cfg.DemoAllowedImagePrefixes,
	}
}

// ProblemDemoPolicy is one entry of a demo-restricted Problem's demo_policy
// (#350): where a demo account's manifest breaks the demo's limits.
type ProblemDemoPolicy struct {
	// Rule is job-backoff-limit, job-ttl, cronjob-history-limit or image-prefix.
	Rule      string `json:"rule"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Container string `json:"container,omitempty"`
	// Field is the path within the object.
	Field string `json:"field"`
	// Limit is the cap, for the numeric rules. The image-prefix rule never says
	// which prefixes are allowed: the demo's accounts are public.
	Limit *int64 `json:"limit,omitempty"`
	Got   any    `json:"got,omitempty"`
}

func withDemoPolicy(violations []template.DemoViolation) problemOption {
	return func(p *Problem) {
		p.DemoPolicy = make([]ProblemDemoPolicy, len(violations))
		for i, v := range violations {
			p.DemoPolicy[i] = ProblemDemoPolicy{
				Rule: v.Rule, Kind: v.Kind, Name: v.Name, Container: v.Container,
				Field: v.Field, Limit: v.Limit, Got: v.Got,
			}
		}
	}
}

// demoPolicyDetail says what the first violation is, and how many follow.
func demoPolicyDetail(violations []template.DemoViolation) string {
	v := violations[0]
	var what string
	switch {
	case v.Rule == "image-prefix":
		what = fmt.Sprintf("%s %s uses image %q in container %q, which demo accounts may not use", v.Kind, v.Name, v.Got, v.Container)
	case v.Limit == nil:
		// A podFailurePolicy rule that ignores failures has no limit to name.
		what = fmt.Sprintf("%s %s sets %s to %v, which demo accounts may not use", v.Kind, v.Name, v.Field, v.Got)
	default:
		what = fmt.Sprintf("%s %s sets %s to %v, above the demo limit of %d", v.Kind, v.Name, v.Field, v.Got, *v.Limit)
	}
	if more := len(violations) - 1; more > 0 {
		what += fmt.Sprintf(" (and %d more)", more)
	}
	return "demo accounts cannot deploy this: " + what
}

// demoPolicyFill is holdToDemoPolicy for a render that follows one it already
// passed with the same values — CreateRelease's second render, which stamps the
// release id — and so cannot break the policy. It fills the same limits and
// writes no response; a violation there is an error.
func (h *Handlers) demoPolicyFill(c *gin.Context, rendered []byte) ([]byte, error) {
	if !h.demoPolicy.Enabled() || h.deps.DemoEmailDomain == "" || !h.isDemoCaller(c) {
		return rendered, nil
	}
	out, violations, err := template.ApplyDemoPolicy(rendered, h.demoPolicy)
	if err != nil {
		return nil, err
	}
	if len(violations) > 0 {
		return nil, fmt.Errorf("demo policy: %d violations after a render with the same values passed", len(violations))
	}
	return out, nil
}

// holdToDemoPolicy applies the demo policy to a demo caller's rendered manifest
// (#350) and returns the manifest to use: filled where the template left a limit
// unset. A manifest that breaks the policy is answered 403 demo-restricted, and
// ok is false. Anyone else, or an install with no policy, gets rendered back
// untouched.
func (h *Handlers) holdToDemoPolicy(c *gin.Context, op string, rendered []byte) (out []byte, ok bool) {
	if !h.demoPolicy.Enabled() || h.deps.DemoEmailDomain == "" || !h.isDemoCaller(c) {
		return rendered, true
	}
	out, violations, err := template.ApplyDemoPolicy(rendered, h.demoPolicy)
	if err != nil {
		internalError(c, op+": demo policy", err)
		return nil, false
	}
	if len(violations) > 0 {
		log.Printf("demo policy refused id=%s op=%s rules=%d first=%s", requestIDFrom(c), op, len(violations), violations[0].Rule)
		writeError(c, http.StatusForbidden, "demo-restricted", demoPolicyDetail(violations), withDemoPolicy(violations))
		return nil, false
	}
	return out, true
}
