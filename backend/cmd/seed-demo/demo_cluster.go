package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// checkDemoCluster proves the cluster the seed releases go to is registered
// (#363). The seed creates them through POST /v1/releases, which answers 404
// for a cluster name it does not know — after the reset has already emptied
// the demo. A chart installed with the default demo.cluster on a cluster
// registered under another name failed that way on every reset, and nothing in
// the Job's log said which name it wanted or which ones exist.
func checkDemoCluster(ctx context.Context, c *apiClient, name string) error {
	code, b, err := c.do(ctx, http.MethodGet, "/v1/clusters", nil)
	if err != nil || code != http.StatusOK {
		return fmt.Errorf("/v1/clusters: %d %s %v", code, b, err)
	}
	var body struct {
		Clusters []struct {
			Name string `json:"name"`
		} `json:"clusters"`
	}
	if err := json.Unmarshal(b, &body); err != nil {
		return fmt.Errorf("/v1/clusters: %w", err)
	}
	names := make([]string, 0, len(body.Clusters))
	for _, cl := range body.Clusters {
		if cl.Name == name {
			return nil
		}
		names = append(names, cl.Name)
	}
	registered := "none"
	if len(names) > 0 {
		registered = strings.Join(names, ", ")
	}
	return fmt.Errorf("DEMO_CLUSTER %q is not a registered cluster (registered: %s) — set demo.cluster to the name "+
		"the cluster was registered under (chart README \"After install\" step 3)", name, registered)
}
