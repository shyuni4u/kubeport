package auth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
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
type MultiVerifier struct {
	byIssuer map[string]*Verifier
	order    []string
}

func NewMultiVerifier(ctx context.Context, cfgs []IssuerConfig) (*MultiVerifier, error) {
	if len(cfgs) == 0 {
		return nil, errors.New("NewMultiVerifier: no issuers")
	}
	m := &MultiVerifier{byIssuer: make(map[string]*Verifier, len(cfgs))}
	for _, c := range cfgs {
		v, err := NewVerifier(ctx, c.Issuer, c.ClientID)
		if err != nil {
			return nil, fmt.Errorf("issuer %s: %w", c.Issuer, err)
		}
		m.byIssuer[c.Issuer] = v
		m.order = append(m.order, c.Issuer)
	}
	return m, nil
}

// Issuers returns the configured issuer URLs in configuration order.
func (m *MultiVerifier) Issuers() []string { return append([]string(nil), m.order...) }

func (m *MultiVerifier) Verify(ctx context.Context, rawToken string) (Claims, error) {
	iss, err := peekIssuer(rawToken)
	if err != nil {
		return Claims{}, err
	}
	v, ok := m.byIssuer[iss]
	if !ok {
		return Claims{}, fmt.Errorf("unknown issuer %q", iss)
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
