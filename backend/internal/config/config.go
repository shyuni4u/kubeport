package config

import "time"

type Config struct {
	ListenAddr          string
	DatabaseURL         string
	OIDCIssuer          string // legacy single issuer (kept for backwards compat)
	OIDCAudience        string // legacy single audience
	OIDCIssuersJSON     string // KBP_OIDC_ISSUERS — JSON [{issuer, client_id}]; wins over the legacy pair
	DemoEmailDomain     string // KBP_DEMO_EMAIL_DOMAIN — "" disables demo restrictions
	AppEncryptionKeyB64 string
	OpenAPICacheMax     int
	// SessionReapInterval — KBP_SESSION_REAP_INTERVAL. How often expired
	// sessions are deleted. Zero uses session.DefaultInterval.
	SessionReapInterval time.Duration
	// DemoAllowTemplateCreate — KBP_DEMO_ALLOW_TEMPLATE_CREATE. Lets demo
	// accounts author templates. Off by default; see api.Deps for why.
	DemoAllowTemplateCreate bool
	// HealthPublicCatalog — KBP_HEALTH_PUBLIC_CATALOG. Lets /healthz?verbose=1
	// report how many templates the catalog holds. Off by default: /healthz is
	// unauthenticated, and on a self-hosted install the catalog's size is not
	// the anonymous internet's business. The public demo turns it on so an
	// external cron can tell that a reset wiped and failed to re-seed (#119).
	HealthPublicCatalog bool
}
