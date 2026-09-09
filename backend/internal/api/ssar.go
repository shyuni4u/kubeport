package api

import (
	"net/http"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"

	"kubeport/internal/auth"
	"kubeport/internal/k8s"
)

// ssarVerbs are the verbs kubeport itself performs, so they are the only ones
// worth asking a cluster about: apply (create/update/patch), delete, and the
// reads behind the release detail page.
var ssarVerbs = map[string]bool{
	"create": true,
	"update": true,
	"patch":  true,
	"delete": true,
	"get":    true,
	"list":   true,
	"watch":  true,
}

func sortedSSARVerbs() []string {
	out := make([]string, 0, len(ssarVerbs))
	for v := range ssarVerbs {
		out = append(out, v)
	}
	sort.Strings(out)
	return out
}

// ssarReq is the POST /v1/selfsubjectaccessreview body.
//
// cluster is selected by name (not ID) so the frontend can pass whatever the
// user chose in the cluster dropdown. Only cluster + verb + resource are
// strictly required — namespace is empty for cluster-scoped resources, group
// is empty for the core API group, name is empty for collection-scope checks.
type ssarReq struct {
	Cluster   string `json:"cluster"`
	Namespace string `json:"namespace"`
	Verb      string `json:"verb"`
	Group     string `json:"group"`
	Resource  string `json:"resource"`
	Name      string `json:"name"`
}

// CheckSelfSubjectAccess asks the target cluster "can the caller do verb on
// this resource?" using a SelfSubjectAccessReview forwarded with the caller's
// OIDC token. Used by the deploy form to warn about likely apply-time
// denials (debounced per resource kind on the client side).
//
// No admin gate: any authenticated caller can ask "can I...?"; the cluster's
// own authorizer decides the answer.
//
// Error mapping:
//   - malformed JSON body                  → 400 validation-error
//   - missing cluster/verb/resource        → 400 validation-error
//   - unknown cluster                      → 404 not-found
//   - k8s client construction fails        → 500 k8s-error
//   - SSAR API call fails (upstream error) → 502 k8s-error
//
// Response shape: {"allowed": bool, "denied": bool, "reason": string}.
func (h *Handlers) CheckSelfSubjectAccess(c *gin.Context) {
	var req ssarReq
	if err := c.ShouldBindJSON(&req); err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", err.Error())
		return
	}
	if req.Cluster == "" || req.Verb == "" || req.Resource == "" {
		writeError(c, http.StatusBadRequest, "validation-error",
			"cluster, verb, and resource are required")
		return
	}
	// Every question here turns into a real call to the target apiserver, so
	// bound what can be asked to what kubeport itself does (issue #73). SSAR
	// never grants anything — it reports the caller's own access — but an
	// unbounded proxy is still an unmetered load path onto a single-node
	// control plane, and the demo is open to anyone.
	if !ssarVerbs[req.Verb] {
		writeError(c, http.StatusBadRequest, "validation-error",
			"verb must be one of: "+strings.Join(sortedSSARVerbs(), ", "))
		return
	}
	if !k8s.IsMVPResource(req.Group, req.Resource) {
		writeError(c, http.StatusBadRequest, "validation-error",
			"resource is not one kubeport manages; see the MVP kind list")
		return
	}

	ctx := c.Request.Context()
	cluster, err := h.deps.Store.GetClusterByName(ctx, req.Cluster)
	if err != nil {
		writeError(c, http.StatusNotFound, "not-found", "cluster")
		return
	}

	u, _ := auth.UserFrom(ctx)
	cli, err := h.deps.K8sFactory.NewWithToken(cluster.ApiUrl, cluster.CaBundle.String, u.IDToken)
	if err != nil {
		// Matches releases.go:188 — surface raw err.Error() for debugging
		// (e.g. "caBundle is required"). Does not leak DB internals.
		internalError(c, "CheckSelfSubjectAccess: k8s client", err)
		return
	}

	out, err := cli.CheckAccess(ctx, k8s.AccessCheck{
		Namespace: req.Namespace,
		Verb:      req.Verb,
		Group:     req.Group,
		Resource:  req.Resource,
		Name:      req.Name,
	})
	if err != nil {
		// 502 matches the "upstream k8s failed" semantics used in releases.go
		// (ApplyAll / DeleteByRelease errors also surface as 502).
		writeError(c, http.StatusBadGateway, "k8s-error", err.Error())
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"allowed": out.Allowed,
		"denied":  out.Denied,
		"reason":  out.Reason,
	})
}
