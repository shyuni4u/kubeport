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
		log.Printf("proxyOpenAPI: transport for cluster %s: %v", name, err)
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
		writeError(c, http.StatusBadGateway, "k8s-error", err.Error())
		return
	}
	defer resp.Body.Close()

	// Read one byte past the cap so we can distinguish "exactly at limit" from
	// "overflowed the limit" — io.LimitReader silently truncates otherwise.
	body, err := io.ReadAll(io.LimitReader(resp.Body, int64(openapiMaxBytes)+1))
	if err != nil {
		writeError(c, http.StatusBadGateway, "k8s-error", err.Error())
		return
	}
	if len(body) > openapiMaxBytes {
		writeError(c, http.StatusBadGateway, "k8s-error", "OpenAPI response exceeds 10MiB limit")
		return
	}
	if resp.StatusCode >= 400 {
		writeError(c, resp.StatusCode, "k8s-error", string(body))
		return
	}

	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/json"
	}
	h.openapi.cache.Add(key, openapiCacheEntry{body: body, storedAt: time.Now(), contentTy: ct})
	c.Data(http.StatusOK, ct, body)
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
