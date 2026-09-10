package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"kubeport/internal/api"
	"kubeport/internal/auth"
	"kubeport/internal/config"
	"kubeport/internal/k8s"
	"kubeport/internal/session"
	"kubeport/internal/store"
)

// k8sFactory adapts the k8s package constructors to api.K8sClientFactory.
//
// Every caller of this factory forwards the user's id_token to the cluster —
// deploy, delete, logs, SSAR. An unverified connection there means handing a
// bearer token to whoever answers the address. So an empty CA bundle is
// refused unless the operator opted in, the same gate openapi_proxy.go already
// applies to schema reads; before, the read path was guarded and the write
// path was not (issue #96).
type k8sFactory struct{}

func (k8sFactory) NewWithToken(apiURL, caBundle, bearer string) (api.K8sApplier, error) {
	if strings.TrimSpace(caBundle) == "" {
		if os.Getenv("KBP_DEV_ALLOW_INSECURE_CLUSTERS") != "true" {
			return nil, fmt.Errorf(
				"cluster %s has no ca_bundle; register one, or set KBP_DEV_ALLOW_INSECURE_CLUSTERS=true for local dev (never in production)",
				apiURL)
		}
		log.Printf("WARN: connecting to %s with TLS verification disabled (KBP_DEV_ALLOW_INSECURE_CLUSTERS=true)", apiURL)
		return k8s.NewInsecureWithToken(apiURL, bearer)
	}
	return k8s.NewWithToken(apiURL, caBundle, bearer)
}

func main() {
	cfg := config.Config{
		ListenAddr:              getenv("LISTEN_ADDR", ":8080"),
		DatabaseURL:             os.Getenv("DATABASE_URL"),
		OIDCIssuer:              os.Getenv("OIDC_ISSUER"),
		OIDCAudience:            os.Getenv("OIDC_AUDIENCE"),
		OIDCIssuersJSON:         os.Getenv("KBP_OIDC_ISSUERS"),
		DemoEmailDomain:         os.Getenv("KBP_DEMO_EMAIL_DOMAIN"),
		DemoAllowTemplateCreate: os.Getenv("KBP_DEMO_ALLOW_TEMPLATE_CREATE") == "true",
		HealthPublicCatalog:     os.Getenv("KBP_HEALTH_PUBLIC_CATALOG") == "true",
		AppEncryptionKeyB64:     os.Getenv("APP_ENCRYPTION_KEY_B64"),
		OpenAPICacheMax:         getenvInt("KBP_OPENAPI_CACHE_MAX", 64),
		SessionReapInterval:     getenvDuration("KBP_SESSION_REAP_INTERVAL", session.DefaultInterval),
		// Unset means 0, which the api package turns into its own default —
		// one place holds the number rather than two that can drift.
		LogStreamsPerCaller:  getenvInt("KBP_LOG_STREAMS_PER_CALLER", 0),
		LogStreamMaxLifetime: getenvDuration("KBP_LOG_STREAM_MAX_LIFETIME", 0),
	}

	issuers, err := resolveIssuers(cfg)
	if err != nil {
		log.Fatalf("OIDC config: %v (local dev: OIDC_ISSUER=https://host.docker.internal:5556 OIDC_AUDIENCE=kubeport, or KBP_OIDC_ISSUERS JSON)", err)
	}
	if cfg.DatabaseURL == "" {
		log.Fatal("DATABASE_URL is required (local dev: postgres://kubeport:kubeport@localhost:5432/kubeport?sslmode=disable)")
	}
	if cfg.DemoEmailDomain != "" {
		log.Printf("demo restrictions enabled for *@%s", cfg.DemoEmailDomain)
		if cfg.DemoAllowTemplateCreate {
			log.Printf("WARN: KBP_DEMO_ALLOW_TEMPLATE_CREATE=true — demo accounts may author templates. " +
				"Their templates stay out of real users' catalogs, but they persist past a demo reset " +
				"once someone deploys from them.")
		}
	}

	if emails := os.Getenv("KBP_DEV_ADMIN_EMAILS"); emails != "" {
		log.Printf("WARN: KBP_DEV_ADMIN_EMAILS is set, elevating %q to kubeport-admin — dev only, never set in production", emails)
	}

	ctx := context.Background()
	verifier, err := auth.NewMultiVerifier(ctx, issuers)
	if err != nil {
		log.Fatalf("OIDC verifier init: %v", err)
	}
	// Discovery is lazy per issuer; any issuer that was unreachable just now
	// logged a WARN above and will be retried on its first token.
	log.Printf("trusting OIDC issuers: %v", verifier.Issuers())
	st, err := store.NewStore(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("store init: %v", err)
	}
	defer st.Close()

	// Expired sessions are unusable the moment they expire but were never
	// deleted, so the table grew forever with encrypted id/refresh tokens in it.
	session.StartReaper(ctx, st, cfg.SessionReapInterval, session.DefaultBatchSize)

	r := api.NewRouter(cfg, api.Deps{
		Verifier:                verifier,
		Store:                   st,
		K8sFactory:              k8sFactory{},
		DemoEmailDomain:         cfg.DemoEmailDomain,
		DemoAllowTemplateCreate: cfg.DemoAllowTemplateCreate,
		HealthPublicCatalog:     cfg.HealthPublicCatalog,
	})
	log.Printf("listening on %s", cfg.ListenAddr)
	if err := newHTTPServer(cfg.ListenAddr, r).ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

// newHTTPServer is the server this process listens with.
//
// It replaces gin's r.Run, which is a zero-value http.Server with no timeout of
// any kind: a client could send its headers one byte at a time and hold a
// connection for as long as it liked (#169).
//
// Only two timeouts are set, because this process serves long-lived
// Server-Sent Events and the other two would end them. WriteTimeout is a
// deadline on the whole response, so every log stream would be cut at that
// age. ReadTimeout's deadline stays on the connection while the handler runs,
// and when it expires the server's background read fails and cancels the
// request context — ending the stream just the same. ReadHeaderTimeout bounds
// only the handshake, and IdleTimeout only keep-alive sockets between
// requests; neither touches a response in progress.
//
// IdleTimeout is longer than the proxy's on purpose. Traefik keeps an idle
// upstream connection to this process for up to 90s (serversTransport
// forwardingTimeouts.idleConnTimeout, its default; production does not set
// it). If this side closed an idle socket first, Traefik could hand that
// socket the next request just as it closed, and the request would come back
// as a 502. At 120s the proxy always retires the connection before we do.
func newHTTPServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func getenvInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		n, err := strconv.Atoi(v)
		if err == nil {
			return n
		}
	}
	return def
}

// getenvDuration parses a Go duration ("30m", "2h"). An unparseable value falls
// back to the default with a warning rather than failing startup — a typo in an
// operational knob shouldn't take the app down.
func getenvDuration(k string, def time.Duration) time.Duration {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		log.Printf("WARN: %s=%q is not a duration (%v); using %s", k, v, err, def)
		return def
	}
	return d
}

// resolveIssuers prefers KBP_OIDC_ISSUERS; falls back to the legacy
// OIDC_ISSUER/OIDC_AUDIENCE pair so existing deploys keep working.
func resolveIssuers(cfg config.Config) ([]auth.IssuerConfig, error) {
	if cfg.OIDCIssuersJSON != "" {
		return auth.ParseIssuersJSON(cfg.OIDCIssuersJSON)
	}
	if cfg.OIDCIssuer == "" || cfg.OIDCAudience == "" {
		return nil, errors.New("set KBP_OIDC_ISSUERS or both OIDC_ISSUER and OIDC_AUDIENCE")
	}
	return []auth.IssuerConfig{{Issuer: cfg.OIDCIssuer, ClientID: cfg.OIDCAudience}}, nil
}
