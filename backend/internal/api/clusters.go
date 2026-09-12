package api

import (
	"crypto/x509"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"kubeport/internal/store"
)

const pgUniqueViolation = "23505"

type createClusterReq struct {
	Name             string `json:"name"               binding:"required,min=1"`
	DisplayName      string `json:"display_name"`
	APIURL           string `json:"api_url"            binding:"required,url"`
	CABundle         string `json:"ca_bundle"`
	OIDCIssuerURL    string `json:"oidc_issuer_url"    binding:"required,url"`
	DefaultNamespace string `json:"default_namespace"`
}

// clusterSummary is the only shape GET /v1/clusters returns. It deliberately
// drops api_url, ca_bundle and oidc_issuer_url: those describe how to reach a
// cluster's apiserver, and the list is readable by every authenticated caller.
//
// This is not role-dependent on purpose. Gating the full record behind
// isKubeportAdmin would not have closed the hole the finding was about: when
// demo mode is on, the chart appends demo.adminEmail to KBP_DEV_ADMIN_EMAILS
// (templates/_helpers.tpl "kubeport.devAdminEmails"), so the public demo
// admin *is* in the kubeport-admin group and would still have read the
// production cluster's endpoint. One shape also means a client never has to
// guess why a field is absent.
//
// Nothing reads the dropped fields off this endpoint — the deploy form and
// both template editors use name/default_namespace, POST /v1/releases and the
// SSAR take a cluster name. An admin registering a cluster still gets the full
// record back from POST /v1/clusters.
type clusterSummary struct {
	ID               pgtype.UUID `json:"id"`
	Name             string      `json:"name"`
	DisplayName      pgtype.Text `json:"display_name"`
	DefaultNamespace pgtype.Text `json:"default_namespace"`
}

func (h *Handlers) ListClusters(c *gin.Context) {
	cs, err := h.deps.Store.ListClusters(c.Request.Context())
	if err != nil {
		internalError(c, "ListClusters", err)
		return
	}

	out := make([]clusterSummary, 0, len(cs))
	for _, cl := range cs {
		out = append(out, clusterSummary{
			ID:               cl.ID,
			Name:             cl.Name,
			DisplayName:      cl.DisplayName,
			DefaultNamespace: cl.DefaultNamespace,
		})
	}
	c.JSON(http.StatusOK, gin.H{"clusters": out})
}

// validateCABundle rejects a cluster registration that would be unusable.
//
// The same rule the k8s factory applies at connect time, applied where the
// operator can still act on it. `KBP_DEV_ALLOW_INSECURE_CLUSTERS=true` skips
// the requirement for local kind clusters, exactly as it does there.
func validateCABundle(pem string) error {
	if strings.TrimSpace(pem) == "" {
		if os.Getenv("KBP_DEV_ALLOW_INSECURE_CLUSTERS") == "true" {
			return nil
		}
		return errors.New("ca_bundle is required: without it kubeport would send the user's token " +
			"over an unverified connection, so deploys to this cluster would be refused. " +
			"Set KBP_DEV_ALLOW_INSECURE_CLUSTERS=true for local dev only")
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM([]byte(pem)) {
		return errors.New("ca_bundle is not valid PEM")
	}
	return nil
}

// normalizeAPIURL is an apiserver URL in one spelling: scheme and host
// lowercased, a trailing dot on the host and a default port dropped, no
// trailing slash. A URL that does not parse is compared as typed, trimmed.
func normalizeAPIURL(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return strings.TrimSpace(raw)
	}
	scheme := strings.ToLower(u.Scheme)
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	port := u.Port()
	if (scheme == "https" && port == "443") || (scheme == "http" && port == "80") {
		port = ""
	}
	if port != "" {
		host = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	return scheme + "://" + host + strings.TrimRight(u.EscapedPath(), "/")
}

func (h *Handlers) CreateCluster(c *gin.Context) {
	var r createClusterReq
	if !bindJSON(c, &r) {
		return
	}
	// Refuse here rather than at deploy time. Without a CA the k8s factory now
	// declines to build a client (#96), so a cluster registered without one
	// accepts 201 and then fails every deploy with a generic 500 whose reason
	// is only in the pod log — and GetRelease reports it as "cluster
	// unreachable", which points the operator at the network instead of the
	// missing field.
	if err := validateCABundle(r.CABundle); err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", err.Error())
		return
	}
	// One apiserver under two names let releases under each share a name and
	// namespace — each other's objects — since the release name is unique only
	// per registered cluster (#195). Objects now carry the release's id, so a
	// takeover is refused either way; refusing the second registration keeps the
	// catalog from offering two targets that are one cluster.
	//
	// Normalised, not compared as typed, so a trailing slash, a trailing dot or
	// an explicit default port is not a new cluster. A second DNS name or an IP
	// for the same apiserver cannot be told apart from here.
	//
	// The check and the insert run under one lock, in one transaction: checked
	// first and inserted after, two registrations of one apiserver arriving
	// together both passed (codex review).
	ctx := c.Request.Context()
	var cl store.Cluster
	var registeredAs string
	err := h.deps.Store.WithTx(ctx, func(q *store.Queries) error {
		if err := q.LockClusterRegistration(ctx); err != nil {
			return err
		}
		existing, err := q.ListClusters(ctx)
		if err != nil {
			return err
		}
		for _, other := range existing {
			// The same name is the name clash the insert reports, which is the
			// clearer answer when both match.
			if other.Name != r.Name && normalizeAPIURL(other.ApiUrl) == normalizeAPIURL(r.APIURL) {
				registeredAs = other.Name
				return nil
			}
		}
		cl, err = q.InsertCluster(ctx, store.InsertClusterParams{
			Name:             r.Name,
			DisplayName:      store.PgText(r.DisplayName),
			ApiUrl:           r.APIURL,
			CaBundle:         store.PgText(r.CABundle),
			OidcIssuerUrl:    r.OIDCIssuerURL,
			DefaultNamespace: store.PgText(r.DefaultNamespace),
		})
		return err
	})
	if err == nil && registeredAs != "" {
		writeError(c, http.StatusConflict, "conflict",
			"api_url is already registered as cluster "+strconv.Quote(registeredAs)+"; register each apiserver once")
		return
	}
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == pgUniqueViolation {
			writeError(c, http.StatusConflict, "conflict", "cluster name already exists")
			return
		}
		internalError(c, "CreateCluster", err)
		return
	}
	c.JSON(http.StatusCreated, cl)
}
