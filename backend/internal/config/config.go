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
}
