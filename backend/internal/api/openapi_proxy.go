package api

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	lru "github.com/hashicorp/golang-lru/v2"

	"kubeport/internal/auth"
)

type openapiCacheKey struct {
	cluster string
	user    string // oidc subject
	gv      string // "" for the index, "apps/v1" etc. otherwise
}

type openapiCacheEntry struct {
	body      []byte
	storedAt  time.Time
	contentTy string
}

type openapiProxy struct {
	cache      *lru.Cache[openapiCacheKey, openapiCacheEntry]
	transports sync.Map // map[string]http.RoundTripper, key = caBundle string (empty ok)
}

const openapiTTL = 60 * time.Minute

// openapiMaxBytes caps an OpenAPI response we will read from an upstream
// cluster. Larger bodies are rejected with 502 rather than silently truncated
// and cached (io.LimitReader on its own does not surface overflow).
const openapiMaxBytes = 10 * 1024 * 1024

func newOpenAPIProxy(size int) *openapiProxy {
	if size <= 0 {
		size = 64
	}
	c, _ := lru.New[openapiCacheKey, openapiCacheEntry](size)
	return &openapiProxy{cache: c}
}

func (p *openapiProxy) transportFor(caBundle string) (http.RoundTripper, error) {
	if v, ok := p.transports.Load(caBundle); ok {
		return v.(http.RoundTripper), nil
	}
	t, err := buildTransport(caBundle)
	if err != nil {
		return nil, err
	}
	if existing, loaded := p.transports.LoadOrStore(caBundle, t); loaded {
		return existing.(http.RoundTripper), nil
	}
	return t, nil
}

func (h *Handlers) GetOpenAPIIndex(c *gin.Context) {
	h.proxyOpenAPI(c, "")
}

func (h *Handlers) GetOpenAPIGroupVersion(c *gin.Context) {
	gv := strings.TrimPrefix(c.Param("gv"), "/")
	if gv == "" {
		writeError(c, http.StatusBadRequest, "validation-error", "gv required")
		return
	}
	// Reject before the cluster lookup so a malformed gv never reaches the
	// store or the response cache.
	if _, err := openapiUpstreamSegments(gv); err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", err.Error())
		return
	}
	h.proxyOpenAPI(c, gv)
}

func (h *Handlers) RefreshOpenAPI(c *gin.Context) {
	cluster := c.Param("name")
	u, ok := auth.UserFrom(c.Request.Context())
	if !ok {
		writeError(c, http.StatusUnauthorized, "unauthenticated", "user not in context")
		return
	}
	// hashicorp/golang-lru/v2 is internally synchronized; no external mutex
	// is needed. Keys() returns a snapshot, so a concurrent Add during the
	// loop is fine (it simply won't be observed and the TTL check catches
	// staleness on the next read).
	for _, k := range h.openapi.cache.Keys() {
		if k.cluster == cluster && k.user == u.Subject {
			h.openapi.cache.Remove(k)
		}
	}
	c.Status(http.StatusNoContent)
}

func (h *Handlers) proxyOpenAPI(c *gin.Context, gv string) {
	name := c.Param("name")
	cluster, err := h.deps.Store.GetClusterByName(c, name)
	if err != nil {
		writeError(c, http.StatusNotFound, "not-found", "cluster "+name)
		return
	}
	u, ok := auth.UserFrom(c.Request.Context())
	if !ok {
		writeError(c, http.StatusUnauthorized, "unauthenticated", "user not in context")
		return
	}

	key := openapiCacheKey{cluster: name, user: u.Subject, gv: gv}
	if e, ok := h.openapi.cache.Get(key); ok && time.Since(e.storedAt) < openapiTTL {
		c.Data(http.StatusOK, e.contentTy, e.body)
		return
	}

	// Empty gv is the index. A bare version ("v1") means core; a "group/version"
	// pair is a named group. Routing everything through /apis/ was breaking core
	// resources like Service and ConfigMap with 404. See openapi_path.go for the
	// segment rules — never concatenate gv into the path.
	segs, err := openapiUpstreamSegments(gv)
	if err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", err.Error())
		return
	}
	up, err := url.Parse(cluster.ApiUrl)
	if err != nil {
		internalError(c, "proxyOpenAPI: parse cluster api_url", err)
		return
	}
	// JoinPath preserves any base prefix in the cluster URL (e.g. a reverse
	// proxy routing /k8s-cluster-1/… to the apiserver) instead of stomping it.
	root := up.JoinPath("openapi", "v3")
	up = root.JoinPath(segs...)
	// Second line of defence behind the validation above: whatever we send must
	// stay under the cluster's OpenAPI root (issue #11).
	if !strings.HasPrefix(up.EscapedPath(), root.EscapedPath()) {
		writeError(c, http.StatusBadRequest, "validation-error", errOpenAPIBadGroupVersion.Error())
		return
	}
	req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodGet, up.String(), nil)
	if err != nil {
		internalError(c, "proxyOpenAPI: build upstream request", err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+u.IDToken)
	req.Header.Set("Accept", "application/json")

	tr, err := h.openapi.transportFor(cluster.CaBundle.String)
	if err != nil {
		// The reason ("ca_bundle is not valid PEM", "no ca_bundle") is for the
		// operator, not the caller — it goes to the log with the cluster name.
		logWithheld(c, "proxyOpenAPI: transport for cluster "+name, err)
		writeError(c, http.StatusInternalServerError, "cluster-config",
			"the cluster's TLS configuration is not usable; check its ca_bundle")
		return
	}
	client := &http.Client{
		Transport: tr,
		Timeout:   30 * time.Second,
	}
	resp, err := client.Do(req)
	if err != nil {
		upstreamError(c, "proxyOpenAPI: upstream request", err)
		return
	}
	defer resp.Body.Close()

	// Read one byte past the cap so we can distinguish "exactly at limit" from
	// "overflowed the limit" — io.LimitReader silently truncates otherwise.
	body, err := io.ReadAll(io.LimitReader(resp.Body, int64(openapiMaxBytes)+1))
	if err != nil {
		upstreamError(c, "proxyOpenAPI: read upstream response", err)
		return
	}
	if len(body) > openapiMaxBytes {
		writeError(c, http.StatusBadGateway, "k8s-error", "OpenAPI response exceeds 10MiB limit")
		return
	}
	// Anything but 200 is folded, not just 4xx/5xx. A 3xx with no Location
	// survives http.Client's redirect following, and the old `>= 400` guard let
	// it fall through to the success path below — where the upstream body and
	// content type were cached under a 200 for an hour.
	if resp.StatusCode != http.StatusOK {
		h.writeUpstreamOpenAPIError(c, name, resp.StatusCode, body)
		return
	}

	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/json"
	}
	h.openapi.cache.Add(key, openapiCacheEntry{body: body, storedAt: time.Now(), contentTy: ct})
	c.Data(http.StatusOK, ct, body)
}

// upstreamDetailMax bounds how much of an upstream error body is quoted back.
// The 10MiB read cap exists so a schema fits; it is not a sensible size for a
// Problem detail, and nothing downstream reads past the first sentence anyway.
const upstreamDetailMax = 512

// writeUpstreamOpenAPIError maps a status the *cluster* chose onto one kubeport
// owns. Passing the upstream status through verbatim made two of them lie
// (issue #83):
//
//   - 401/403 said "your kubeport session is bad" when the cluster had refused
//     the forwarded token. A client re-authenticates, gets an equally
//     unwelcome token, and loops. PR #79 made "401 on /v1 means
//     unauthenticated" an invariant; these two routes were the only exception,
//     so the collision gets its own kind instead.
//   - 429 collided with kubeport's own rate limiter, whose 429 carries
//     Retry-After. A client would wait on a header that is not there.
//
// 404 is kept as-is: "this cluster has no apps/v99" is the apiserver answering
// the question that was actually asked, and the editor's kind autocomplete
// needs it to tell an unknown group from an unreachable cluster. It is
// distinguishable from kubeport's own 404 (`not-found`) by title.
func (h *Handlers) writeUpstreamOpenAPIError(c *gin.Context, cluster string, status int, body []byte) {
	switch {
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		log.Printf("id=%s proxyOpenAPI: cluster %s refused the caller's token: %d", requestIDFrom(c), cluster, status)
		writeError(c, http.StatusBadGateway, "cluster-auth-denied",
			"the cluster rejected the credentials kubeport forwarded; this is the cluster's decision, not a kubeport session problem")
	case status == http.StatusNotFound:
		// The apiserver's words go only to the caller this PR decided may read
		// the cluster's words at all — the same predicate the SSAR reason uses
		// (#102). These two routes carry no requireAdmin and no demo gate, and
		// proxyOpenAPI does not check cluster ownership, so "any authenticated
		// caller" here includes a demo visitor pointing at the production
		// cluster. Everyone else gets our sentence, which is all the editor's
		// kind autocomplete needs: it branches on status and title.
		detail := "this cluster has no such group/version"
		if isAdmin(c) && !h.isDemoCaller(c) {
			detail = truncate(string(body), upstreamDetailMax)
		}
		writeError(c, http.StatusNotFound, "k8s-error", detail)
	case status >= 500:
		// The cluster's own trouble, and its body can name internals.
		log.Printf("id=%s proxyOpenAPI: cluster %s returned %d: %s", requestIDFrom(c), cluster, status, truncate(string(body), upstreamDetailMax))
		writeError(c, http.StatusBadGateway, "k8s-error", "the cluster's OpenAPI endpoint returned an error")
	default:
		log.Printf("id=%s proxyOpenAPI: cluster %s returned %d: %s", requestIDFrom(c), cluster, status, truncate(string(body), upstreamDetailMax))
		writeError(c, http.StatusBadGateway, "k8s-error",
			"the cluster's OpenAPI endpoint refused the request")
	}
}

// truncate cuts on a rune boundary. Slicing bytes splits a multi-byte
// character and the JSON encoder replaces the half with U+FFFD, so a truncated
// apiserver message came back visibly corrupted rather than merely short.
func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}

// buildTransport returns an http.RoundTripper that trusts the cluster's
// declared CA. Empty CA bundles are rejected in production; set
// KBP_DEV_ALLOW_INSECURE_CLUSTERS=true locally (e.g. for kind with self-
// signed certs) to opt into InsecureSkipVerify. Never set this in prod.
func buildTransport(caBundle string) (http.RoundTripper, error) {
	base, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		return nil, errors.New("http.DefaultTransport is not *http.Transport")
	}
	t := base.Clone()
	if strings.TrimSpace(caBundle) == "" {
		if os.Getenv("KBP_DEV_ALLOW_INSECURE_CLUSTERS") != "true" {
			return nil, errors.New("cluster has no ca_bundle; set KBP_DEV_ALLOW_INSECURE_CLUSTERS=true for local dev")
		}
		t.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
		return t, nil
	}
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	if ok := pool.AppendCertsFromPEM([]byte(caBundle)); !ok {
		return nil, errors.New("ca_bundle is not valid PEM")
	}
	t.TLSClientConfig = &tls.Config{RootCAs: pool}
	return t, nil
}
