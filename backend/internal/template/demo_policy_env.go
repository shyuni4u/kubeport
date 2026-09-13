package template

import (
	"fmt"
	"strconv"
	"strings"
)

// The environment a DemoPolicy is read from (#350). The backend enforces what
// these say, and the demo reset's preflight reads the same keys, so the reset
// finds out before it deletes anything whether the backend would refuse the
// seed.
const (
	EnvDemoJobBackoffLimit      = "KBP_DEMO_JOB_BACKOFF_LIMIT"
	EnvDemoJobTTLSeconds        = "KBP_DEMO_JOB_TTL_SECONDS"
	EnvDemoCronJobHistoryLimit  = "KBP_DEMO_CRONJOB_HISTORY_LIMIT"
	EnvDemoAllowedImagePrefixes = "KBP_DEMO_ALLOWED_IMAGE_PREFIXES"
)

// DemoPolicyFromEnv reads a DemoPolicy through getenv (os.Getenv outside tests).
func DemoPolicyFromEnv(getenv func(string) string) (DemoPolicy, error) {
	var p DemoPolicy
	var err error
	if p.JobBackoffLimit, err = ParseDemoLimit(EnvDemoJobBackoffLimit, getenv(EnvDemoJobBackoffLimit)); err != nil {
		return DemoPolicy{}, err
	}
	if p.JobTTLSecondsAfterFinished, err = ParseDemoLimit(EnvDemoJobTTLSeconds, getenv(EnvDemoJobTTLSeconds)); err != nil {
		return DemoPolicy{}, err
	}
	if p.CronJobHistoryLimit, err = ParseDemoLimit(EnvDemoCronJobHistoryLimit, getenv(EnvDemoCronJobHistoryLimit)); err != nil {
		return DemoPolicy{}, err
	}
	p.ImagePrefixes = ParseImagePrefixes(getenv(EnvDemoAllowedImagePrefixes))
	return p, nil
}

// ParseDemoLimit reads one limit from the environment variable name. Empty
// turns the rule off. Anything but a whole number from 0 to 2147483647 is an
// error, not off: a typo that quietly switched a limit off would reopen what
// the limit closes, and the Job and CronJob fields it fills are int32, so a
// larger limit would be filled into manifests the apiserver refuses — after
// the reset's preflight had passed the seed and the demo was wiped (codex
// review).
func ParseDemoLimit(name, raw string) (*int64, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	n, err := strconv.ParseInt(raw, 10, 32)
	if err != nil || n < 0 {
		return nil, fmt.Errorf("%s must be a whole number from 0 to 2147483647, or unset to turn the rule off (got %q)", name, raw)
	}
	return &n, nil
}

// ParseImagePrefixes reads a comma-separated prefix list. Empty means any image.
func ParseImagePrefixes(raw string) []string {
	var out []string
	for _, p := range strings.Split(raw, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
