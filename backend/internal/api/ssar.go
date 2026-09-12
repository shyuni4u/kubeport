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
//
// `deletecollection` is in the list because that is what release deletion
// actually needs: DeleteByRelease calls DeleteCollection, and the k8s
// authorizer checks it under its own verb, not `delete`. Leaving it out made
// preflight answer a question nobody asks — a caller could be allowed `delete`
// and still have the real delete refused.
var ssarVerbs = map[string]bool{
	"create":           true,
	"update":           true,
	"patch":            true,
	"delete":           true,
	"deletecollection": true,
	"get":              true,
	"list":             true,
	"watch":            true,
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
// own authorizer decides the answer. What is bounded is the shape and the rate
// of the question, because each one becomes a real call to the apiserver (#73).
//
// Error mapping:
//   - malformed JSON body                   → 400 validation-error
//   - missing cluster/verb/resource         → 400 validation-error
//   - verb outside ssarVerbs                → 400 validation-error (lists the set)
//   - (group, resource) outside mvpResources → 400 validation-error (lists the set)
//   - over the per-caller budget            → 429 rate-limited, with Retry-After
//   - unknown cluster                       → 404 not-found
//   - k8s client construction fails         → 500 internal (reason logged, not returned)
//   - SSAR API call fails (upstream error)  → 502 k8s-error
//
// Response shape: {"allowed": bool, "denied": bool, "reason": string}.
func (h *Handlers) CheckSelfSubjectAccess(c *gin.Context) {
	var req ssarReq
	if !bindJSON(c, &req) {
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
		// Name the set rather than pointing at a list the caller cannot read —
		// the verb error above already does, and a client that can only learn
		// the rule by trial and error will keep making the calls this limit
		// exists to prevent.
		writeError(c, http.StatusBadRequest, "validation-error",
			"group/resource must be one of: "+strings.Join(k8s.MVPResourceNames(), ", "))
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
		// The reason names the cluster's api_url (see #96), so it goes to the
		// log and the caller gets the request id to quote (#49).
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
		upstreamError(c, "CheckSelfSubjectAccess", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"allowed": out.Allowed,
		"denied":  out.Denied,
		"reason":  h.visibleSSARReason(c, out.Reason),
	})
}

// visibleSSARReason decides who gets to read the authorizer's own sentence.
//
// The RBAC authorizer explains itself by naming the objects involved:
//
//	RBAC: allowed by ClusterRoleBinding "kubeport-demo" of ClusterRole
//	"kubeport-demo-deployer" to User "demo-user@demo.kubeport"
//
// SSAR is open to every authenticated caller by design — it reports only the
// caller's own access, so no privilege boundary is crossed. What was crossed is
// an information one: asking the same question across namespaces let anyone who
// could log in map the cluster's binding names, and on the live demo "anyone
// who can log in" means anyone at all, because the demo password is printed on
// the landing page (issue #102).
//
// Real operators keep it: it names the binding they would have to edit, and
// they can read the cluster's RBAC directly anyway. Demo accounts do not, even
// though they carry kubeport-admin — that group exists so they can show the
// admin UX, not so the demo publishes the host cluster's layout.
//
// The frontend already renders its own sentence for the user and uses this
// only as admin hover text (RBACCheckPanel.tsx), so an empty string costs a
// non-admin nothing they were meant to see.
func (h *Handlers) visibleSSARReason(c *gin.Context, reason string) string {
	if isAdmin(c) && !h.isDemoCaller(c) {
		return reason
	}
	return ""
}
