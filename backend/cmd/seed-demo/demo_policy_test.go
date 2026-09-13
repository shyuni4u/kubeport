package main

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
)

func envOf(kv map[string]string) func(string) string {
	return func(k string) string { return kv[k] }
}

// #350: a demo policy the seed cannot pass must stop the reset while the demo
// is still intact. Issuer and database are unreachable here, so reaching either
// would mean the check runs after something that can hang or delete.
func TestRunPreflight_SeedTheDemoPolicyRefusesStopsBeforeAnyIO(t *testing.T) {
	setDemoEnv(t, "http://127.0.0.1:1", "admin@demo.kubeport")
	t.Setenv("KBP_DEMO_ALLOWED_IMAGE_PREFIXES", "ghcr.io/nginx/,docker.io/library/busybox")

	pf, err := runPreflight(context.Background(), http.DefaultClient, unreachableDSN, "demo.kubeport")

	require.Error(t, err)
	require.Nil(t, pf, "no preflight means reset() is unreachable — the demo keeps its data")
	require.Contains(t, err.Error(), "nightly-job-demo would be refused by the demo policy")
	require.Contains(t, err.Error(), "ghcr.io/does-not-exist/nightly:0.0.0")
}

func TestCheckSeedDemoPolicy(t *testing.T) {
	chartDefaults := map[string]string{
		"KBP_DEMO_JOB_BACKOFF_LIMIT":     "2",
		"KBP_DEMO_JOB_TTL_SECONDS":       "86400",
		"KBP_DEMO_CRONJOB_HISTORY_LIMIT": "1",
	}
	require.NoError(t, checkSeedDemoPolicy(envOf(chartDefaults), "demo"), "the chart's limits are filled into the seed, never refused")

	withSeedImages := map[string]string{"KBP_DEMO_ALLOWED_IMAGE_PREFIXES": "ghcr.io/nginx/,docker.io/library/busybox,ghcr.io/does-not-exist/"}
	for k, v := range chartDefaults {
		withSeedImages[k] = v
	}
	require.NoError(t, checkSeedDemoPolicy(envOf(withSeedImages), "demo"), "the documented seed prefixes admit the seed")

	require.NoError(t, checkSeedDemoPolicy(envOf(nil), "demo"), "no policy, nothing to check")

	err := checkSeedDemoPolicy(envOf(map[string]string{"KBP_DEMO_JOB_BACKOFF_LIMIT": "two"}), "demo")
	require.ErrorContains(t, err, "KBP_DEMO_JOB_BACKOFF_LIMIT must be a whole number",
		"a limit the backend would not start with fails the reset too")
}
