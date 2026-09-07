package auth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"
)

// discoveryTimeout bounds how long a single OIDC discovery attempt (HTTP GET
// of /.well-known/openid-configuration + JWKS fetch inside oidc.NewProvider)
// may take. Without this, an unreachable/blackholed issuer would hang the
// request indefinitely.
const discoveryTimeout = 5 * time.Second

// negativeCacheTTL bounds how often a failed issuer is retried. Without it,
// every request against a persistently-unreachable issuer pays a full
// discoveryTimeout dial on every call.
const negativeCacheTTL = 10 * time.Second

// IssuerConfig is one trusted OIDC issuer + the audience (client_id) tokens
// from it must carry. Serialized as JSON in KBP_OIDC_ISSUERS.
type IssuerConfig struct {
	Issuer   string `json:"issuer"`
	ClientID string `json:"client_id"`
}

// ParseIssuersJSON parses KBP_OIDC_ISSUERS. Rejects empty lists, blank
// fields and duplicate issuers so a misconfigured deploy fails at startup
// instead of at first login.
func ParseIssuersJSON(raw string) ([]IssuerConfig, error) {
	var cfgs []IssuerConfig
	if err := json.Unmarshal([]byte(raw), &cfgs); err != nil {
		return nil, fmt.Errorf("KBP_OIDC_ISSUERS: %w", err)
	}
	if len(cfgs) == 0 {
		return nil, errors.New("KBP_OIDC_ISSUERS: at least one issuer required")
	}
	seen := make(map[string]struct{}, len(cfgs))
	for i, c := range cfgs {
		if c.Issuer == "" || c.ClientID == "" {
			return nil, fmt.Errorf("KBP_OIDC_ISSUERS[%d]: issuer and client_id are required", i)
		}
		if _, dup := seen[c.Issuer]; dup {
			return nil, fmt.Errorf("KBP_OIDC_ISSUERS: duplicate issuer %q", c.Issuer)
		}
		seen[c.Issuer] = struct{}{}
	}
	return cfgs, nil
}

// MultiVerifier verifies ID tokens from several issuers. It peeks the
// unverified `iss` claim to pick the right per-issuer Verifier; that
// Verifier then performs full signature/audience/expiry validation, so a
// forged `iss` only ever selects a verifier that will reject the token.
//
// Discovery is lazy: a per-issuer *Verifier is built on first use and cached.
// An issuer that is unreachable at startup (e.g. the demo Dex is deployed
// after the backend, or its Certificate is not Ready yet) therefore logs a
// warning instead of killing the process; requests carrying its tokens get
// 401 until discovery succeeds, and every request retries.
// issuerState holds the lazily-built Verifier for one issuer plus its own
// lock, so that discovery for one issuer never blocks verification of
// tokens from any other issuer.
type issuerState struct {
	mu       sync.Mutex
	verifier *Verifier
	lastFail time.Time
	failErr  error
}

type MultiVerifier struct {
	cfgs  map[string]IssuerConfig
	order []string

	// states is populated once at construction (one entry per configured
	// issuer) and never mutated afterwards, so it can be read without a
	// lock; only the *issuerState values it points to are mutated, each
	// under its own mutex.
	states map[string]*issuerState
}

func NewMultiVerifier(ctx context.Context, cfgs []IssuerConfig) (*MultiVerifier, error) {
	if len(cfgs) == 0 {
		return nil, errors.New("NewMultiVerifier: no issuers")
	}
	m := &MultiVerifier{
		cfgs:   make(map[string]IssuerConfig, len(cfgs)),
		states: make(map[string]*issuerState, len(cfgs)),
	}
	for _, c := range cfgs {
		if c.Issuer == "" || c.ClientID == "" {
			return nil, errors.New("NewMultiVerifier: issuer and client_id are required")
		}
		if _, dup := m.cfgs[c.Issuer]; dup {
			return nil, fmt.Errorf("NewMultiVerifier: duplicate issuer %q", c.Issuer)
		}
		m.cfgs[c.Issuer] = c
		m.order = append(m.order, c.Issuer)
		m.states[c.Issuer] = &issuerState{}
	}
	for _, c := range cfgs {
		// Warm the cache so a healthy deploy fails fast on a *config* mistake,
		// but never make an unreachable issuer fatal.
		if _, err := m.verifierFor(ctx, c.Issuer); err != nil {
			log.Printf("WARN: issuer %s discovery failed: %v (will retry on first use)", c.Issuer, err)
		}
	}
	return m, nil
}

// verifierFor returns the cached Verifier for iss, performing OIDC discovery
// (bounded by discoveryTimeout) on first use. Each issuer has its own lock,
// so a slow/unreachable issuer only ever blocks callers for that same
// issuer, never callers verifying tokens from other issuers. A failed
// discovery is negatively cached for negativeCacheTTL so a persistently
// unreachable issuer doesn't pay a full discoveryTimeout dial on every call.
func (m *MultiVerifier) verifierFor(ctx context.Context, iss string) (*Verifier, error) {
	st, ok := m.states[iss]
	if !ok {
		return nil, fmt.Errorf("unknown issuer %q", iss)
	}
	c := m.cfgs[iss]

	st.mu.Lock()
	defer st.mu.Unlock()

	if st.verifier != nil {
		return st.verifier, nil
	}
	if !st.lastFail.IsZero() && time.Since(st.lastFail) < negativeCacheTTL {
		return nil, st.failErr
	}

	dctx, cancel := context.WithTimeout(ctx, discoveryTimeout)
	defer cancel()

	v, err := NewVerifier(dctx, c.Issuer, c.ClientID)
	if err != nil {
		wrapped := fmt.Errorf("issuer %s: %w", c.Issuer, err)
		st.lastFail = time.Now()
		st.failErr = wrapped
		return nil, wrapped
	}
	st.verifier = v
	st.lastFail = time.Time{}
	st.failErr = nil
	return v, nil
}

// Issuers returns the configured issuer URLs in configuration order.
func (m *MultiVerifier) Issuers() []string { return append([]string(nil), m.order...) }

func (m *MultiVerifier) Verify(ctx context.Context, rawToken string) (Claims, error) {
	iss, err := peekIssuer(rawToken)
	if err != nil {
		return Claims{}, err
	}
	v, err := m.verifierFor(ctx, iss)
	if err != nil {
		return Claims{}, err
	}
	return v.Verify(ctx, rawToken)
}

// peekIssuer decodes the JWT payload segment and returns `iss` WITHOUT
// verifying the signature. Only used for routing.
func peekIssuer(rawToken string) (string, error) {
	parts := strings.Split(rawToken, ".")
	if len(parts) != 3 {
		return "", errors.New("malformed token: expected 3 segments")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", fmt.Errorf("malformed token payload: %w", err)
	}
	var c struct {
		Iss string `json:"iss"`
	}
	if err := json.Unmarshal(payload, &c); err != nil {
		return "", fmt.Errorf("malformed token claims: %w", err)
	}
	if c.Iss == "" {
		return "", errors.New("token has no iss claim")
	}
	return c.Iss, nil
}
