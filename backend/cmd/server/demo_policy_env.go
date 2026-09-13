package main

import (
	"log"
	"os"
	"strconv"
	"strings"

	"kubeport/internal/config"
)

// logDemoPolicy says at startup which demo manifest rules are on, so an
// operator can tell a limit that is off from one that was never read.
func logDemoPolicy(cfg config.Config) {
	show := func(p *int64) string {
		if p == nil {
			return "off"
		}
		return strconv.FormatInt(*p, 10)
	}
	images := "any"
	if len(cfg.DemoAllowedImagePrefixes) > 0 {
		images = strconv.Itoa(len(cfg.DemoAllowedImagePrefixes)) + " prefixes"
	}
	log.Printf("demo manifest policy: job backoffLimit=%s, job ttlSecondsAfterFinished=%s, cronjob history=%s, images=%s",
		show(cfg.DemoJobBackoffLimit), show(cfg.DemoJobTTLSecondsAfterFinished), show(cfg.DemoCronJobHistoryLimit), images)
}

// optionalLimit reads a demo policy limit (#350). Unset or empty turns the rule
// off. Anything but a whole number of zero or more stops the server: a typo
// that quietly switched a limit off would reopen what the limit closes.
func optionalLimit(name string) *int64 {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return nil
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n < 0 {
		log.Fatalf("%s must be a whole number of zero or more, or unset to turn the rule off (got %q)", name, raw)
	}
	return &n
}

// imagePrefixes reads KBP_DEMO_ALLOWED_IMAGE_PREFIXES, a comma-separated list.
// Empty means demo accounts may use any image.
func imagePrefixes(name string) []string {
	var out []string
	for _, p := range strings.Split(os.Getenv(name), ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
