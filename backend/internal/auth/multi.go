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
)

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
type MultiVerifier struct {
	cfgs  map[string]IssuerConfig
	order []string

	mu       sync.Mutex
	byIssuer map[string]*Verifier
}

func NewMultiVerifier(ctx context.Context, cfgs []IssuerConfig) (*MultiVerifier, error) {
	if len(cfgs) == 0 {
		return nil, errors.New("NewMultiVerifier: no issuers")
	}
	m := &MultiVerifier{
		cfgs:     make(map[string]IssuerConfig, len(cfgs)),
		byIssuer: make(map[string]*Verifier, len(cfgs)),
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
		// Warm the cache so a healthy deploy fails fast on a *config* mistake,
		// but never make an unreachable issuer fatal.
		if _, err := m.verifierFor(ctx, c.Issuer); err != nil {
			log.Printf("WARN: issuer %s discovery failed: %v (will retry on first use)", c.Issuer, err)
		}
	}
	return m, nil
}

// verifierFor returns the cached Verifier for iss, performing OIDC discovery
// on first use. Failures are not cached, so the next request retries.
func (m *MultiVerifier) verifierFor(ctx context.Context, iss string) (*Verifier, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if v, ok := m.byIssuer[iss]; ok {
		return v, nil
	}
	c, ok := m.cfgs[iss]
	if !ok {
		return nil, fmt.Errorf("unknown issuer %q", iss)
	}
	v, err := NewVerifier(ctx, c.Issuer, c.ClientID)
	if err != nil {
		return nil, fmt.Errorf("issuer %s: %w", c.Issuer, err)
	}
	m.byIssuer[iss] = v
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
