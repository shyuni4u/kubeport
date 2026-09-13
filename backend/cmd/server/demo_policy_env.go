package main

import (
	"log"
	"os"
	"strconv"

	"kubeport/internal/config"
	"kubeport/internal/template"
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

// optionalLimit reads a demo policy limit (#350), and stops the server on a
// malformed one — see template.ParseDemoLimit.
func optionalLimit(name string) *int64 {
	n, err := template.ParseDemoLimit(name, os.Getenv(name))
	if err != nil {
		log.Fatal(err)
	}
	return n
}

// imagePrefixes reads KBP_DEMO_ALLOWED_IMAGE_PREFIXES, a comma-separated list.
// Empty means demo accounts may use any image.
func imagePrefixes(name string) []string {
	return template.ParseImagePrefixes(os.Getenv(name))
}
