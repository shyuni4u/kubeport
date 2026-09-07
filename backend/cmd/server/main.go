package main

import (
	"context"
	"errors"
	"log"
	"os"
	"strconv"

	"kubeport/internal/api"
	"kubeport/internal/auth"
	"kubeport/internal/config"
	"kubeport/internal/k8s"
	"kubeport/internal/store"
)

// k8sFactory adapts the k8s package constructors to api.K8sClientFactory.
// Falls back to insecure TLS when no CA bundle is registered for the cluster
// (local dev / kind). Production clusters must register a CA bundle.
type k8sFactory struct{}

func (k8sFactory) NewWithToken(apiURL, caBundle, bearer string) (api.K8sApplier, error) {
	if caBundle == "" {
		return k8s.NewInsecureWithToken(apiURL, bearer)
	}
	return k8s.NewWithToken(apiURL, caBundle, bearer)
}

func main() {
	cfg := config.Config{
		ListenAddr:          getenv("LISTEN_ADDR", ":8080"),
		DatabaseURL:         os.Getenv("DATABASE_URL"),
		OIDCIssuer:          os.Getenv("OIDC_ISSUER"),
		OIDCAudience:        os.Getenv("OIDC_AUDIENCE"),
		OIDCIssuersJSON:     os.Getenv("KBP_OIDC_ISSUERS"),
		DemoEmailDomain:     os.Getenv("KBP_DEMO_EMAIL_DOMAIN"),
		AppEncryptionKeyB64: os.Getenv("APP_ENCRYPTION_KEY_B64"),
		OpenAPICacheMax:     getenvInt("KBP_OPENAPI_CACHE_MAX", 64),
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
	}

	if emails := os.Getenv("KBP_DEV_ADMIN_EMAILS"); emails != "" {
		log.Printf("WARN: KBP_DEV_ADMIN_EMAILS is set, elevating %q to kubeport-admin — dev only, never set in production", emails)
	}

	ctx := context.Background()
	verifier, err := auth.NewMultiVerifier(ctx, issuers)
	if err != nil {
		log.Fatalf("OIDC verifier init: %v", err)
	}
	log.Printf("trusting OIDC issuers: %v", verifier.Issuers())
	st, err := store.NewStore(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("store init: %v", err)
	}
	defer st.Close()

	r := api.NewRouter(cfg, api.Deps{Verifier: verifier, Store: st, K8sFactory: k8sFactory{}, DemoEmailDomain: cfg.DemoEmailDomain})
	log.Printf("listening on %s", cfg.ListenAddr)
	if err := r.Run(cfg.ListenAddr); err != nil {
		log.Fatal(err)
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
