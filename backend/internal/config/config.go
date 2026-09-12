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
	// accounts author templates and publish, deprecate or undeprecate versions.
	// Off by default; see api.Deps for why.
	DemoAllowTemplateCreate bool
	// HealthPublicCatalog — KBP_HEALTH_PUBLIC_CATALOG. Lets /healthz?verbose=1
	// report how many templates the catalog holds. Off by default: /healthz is
	// unauthenticated, and on a self-hosted install the catalog's size is not
	// the anonymous internet's business. The public demo turns it on so an
	// external cron can tell that a reset wiped and failed to re-seed (#119).
	HealthPublicCatalog bool
	// LogStreamsPerCaller — KBP_LOG_STREAMS_PER_CALLER. How many log streams one
	// caller (OIDC subject) may hold open at once. Zero uses the api package's
	// default. The demo's shared accounts share this cap too (#169).
	LogStreamsPerCaller int
	// LogStreamMaxLifetime — KBP_LOG_STREAM_MAX_LIFETIME. How long one log
	// stream stays open before the server ends it and the client reconnects
	// through a fresh token and authorization. Zero uses the api package's
	// default (#169).
	LogStreamMaxLifetime time.Duration
}
