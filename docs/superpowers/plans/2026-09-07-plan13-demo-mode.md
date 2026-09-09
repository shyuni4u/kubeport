# Plan 13 — Demo Mode (Dex demo IdP + seeded accounts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anyone can open https://kubeport.enzo.kr, click "관리자로 체험" or "사용자로 체험", log in via a self-hosted Dex IdP with a published demo password, and use the real product (templates, forms, real deploys into a quota-limited `demo` namespace) with pre-seeded data that resets every 6 hours.

**Architecture:** Dex is added as a *second* OIDC issuer alongside Google. k3s trusts both via `AuthenticationConfiguration` (structured auth); the Go backend verifies both via a `MultiVerifier` that routes on the token's `iss` claim; the Next.js BFF gains a second OIDC provider (`demo`) selected by `?provider=demo` and remembered per session. Demo accounts are ordinary users — the only demo-specific code paths are (a) a 403 guard on cluster registration / team management / force delete for `@demo.kubeport` emails, and (b) the seed/reset job. Isolation is done by Kubernetes (namespace `demo` + Role + ResourceQuota + LimitRange + NetworkPolicy), not by the app.

**Tech Stack:** Go 1.26 + Gin + go-oidc + sqlc + atlas · Next.js 15 + openid-client + next-intl · Dex v2.39 · Helm 3 · k3s (structured authentication config) · Playwright.

**Spec:** [docs/superpowers/specs/2026-09-07-self-improving-loop-design.md](../specs/2026-09-07-self-improving-loop-design.md) §4.1 (this plan), §6 (safety), §7 (tests).

## Global Constraints

- Demo emails are exactly `demo-admin@demo.kubeport` and `demo-user@demo.kubeport`; the demo email domain is `demo.kubeport` (env `KBP_DEMO_EMAIL_DOMAIN`).
- Dex issuer in prod is `https://dex.kubeport.enzo.kr`; Dex client id is `kubeport-demo`. k8s username prefix for dex users is `dex:` (so RBAC subjects are `dex:demo-admin@demo.kubeport`).
- Demo namespace is `demo`. ResourceQuota: `requests.cpu=1`, `requests.memory=2Gi`, `pods=10`, `services=5`, `services.loadbalancers=0`, `count/ingresses.networking.k8s.io=0`. LimitRange default request `100m/128Mi`, default limit and max `500m/512Mi`.
- Reset cadence: CronJob every 6 hours (`0 */6 * * *`). Demo session cookie lifetime 60 minutes.
- Demo accounts get 403 with error type `demo-restricted` on `POST /v1/clusters`, `POST /v1/teams`, `POST/DELETE /v1/teams/:id/members*`, and `DELETE /v1/releases/:id?force=true`. User-facing copy (ko): "데모 계정에서는 사용할 수 없습니다." (en): "Not available for demo accounts."
- All user-facing strings go through `frontend/messages/ko.json` + `en.json`.
- No new env is read in hot request paths; parse at construction time (existing convention in `requireAuth`).
- Git author email must be `shyuniz@naver.com`. Commit messages in English Conventional Commits; PR body in Korean.
- Backend tests assume `docker compose -f deploy/docker/docker-compose.yml up -d` (postgres + dex). Unique test keys use `time.Now().Format("150405.000000")`.
- Never run `kubectl`/`helm`/`ssh` against production from an agent session. Tasks 11–12 (prod cutover) are **human-executed** from the runbook.

---

## File map

| Path | Responsibility |
|---|---|
| `backend/internal/auth/multi.go` (new) | `IssuerConfig`, `MultiVerifier`, `ParseIssuersJSON`, unverified `iss` peek |
| `backend/internal/auth/multi_test.go` (new) | routing/iss tests (unit) + dex integration |
| `backend/internal/auth/demo.go` (new) | `IsDemoEmail(email, domain string) bool` |
| `backend/internal/api/middleware.go` | add `denyDemo(domain string) gin.HandlerFunc` |
| `backend/internal/api/routes.go` | wire `denyDemo` on restricted routes; `Deps.DemoEmailDomain` |
| `backend/internal/api/releases.go:377` | force-delete demo guard |
| `backend/internal/config/config.go` | `OIDCIssuersJSON`, `DemoEmailDomain` |
| `backend/cmd/server/main.go` | build `MultiVerifier` from `KBP_OIDC_ISSUERS` or legacy pair |
| `backend/cmd/seed-demo/main.go` (new) + `fixtures/*.yaml` (new, embedded) | idempotent seed + `--reset` |
| `backend/Dockerfile` | build second binary `/seed-demo` |
| `backend/migrations/schema.hcl`, `schema.sql`, `internal/store/*` | `sessions.provider` column |
| `frontend/lib/oidc.ts` | `getConfig(provider)`, `Provider` type, `demoEnabled()` |
| `frontend/lib/session.ts` | persist/read `provider`; refresh via provider config; 60-min demo expiry |
| `frontend/app/api/auth/login/route.ts`, `callback/route.ts` | `?provider=demo&hint=` and `login_hint` |
| `frontend/app/page.tsx` | landing with 3 buttons + demo credentials |
| `frontend/components/DemoBanner.tsx` (new) | session banner |
| `frontend/components/AppShell.tsx` | render `DemoBanner` for demo emails |
| `frontend/messages/ko.json`, `en.json` | `landing.*`, `demo.*` keys |
| `frontend/tests/e2e/fixtures.ts`, `04-demo-user.spec.ts` (new) | demo login fixtures + smoke |
| `deploy/docker/dex.yaml` | add demo static users locally |
| `deploy/helm/kubeport/templates/dex-*.yaml` (new), `demo-*.yaml` (new) | Dex + demo namespace policy + reset CronJob |
| `deploy/helm/kubeport/values.yaml`, `values-oci-phase2.yaml`, `ci/*.yaml`, `templates/*-configmap.yaml` | `dex.*`, `demo.*` values and env wiring |
| `deploy/oci/k3s-auth-config.sh` (new), `bootstrap.sh`, `README.md §7`, `docs/oci-prod-runbook.md §5` | structured auth cutover + rollback |
| `docs/local-e2e.md` | demo provider env for local |

---

### Task 1: `MultiVerifier` — route tokens by `iss`

**Files:**
- Create: `backend/internal/auth/multi.go`
- Create: `backend/internal/auth/multi_test.go`
- Modify: `backend/internal/auth/export_test.go`

**Interfaces:**
- Produces:
  ```go
  type IssuerConfig struct { Issuer string `json:"issuer"`; ClientID string `json:"client_id"` }
  func ParseIssuersJSON(raw string) ([]IssuerConfig, error)
  type MultiVerifier struct { /* unexported */ }
  func NewMultiVerifier(ctx context.Context, cfgs []IssuerConfig) (*MultiVerifier, error)
  func (m *MultiVerifier) Verify(ctx context.Context, rawToken string) (Claims, error)  // satisfies api.TokenVerifier
  func (m *MultiVerifier) Issuers() []string
  ```
  Internal helper `peekIssuer(rawToken string) (string, error)` decodes the JWT payload **without** signature verification just to read `iss`; the real verification is delegated to the per-issuer `*Verifier`.

- [ ] **Step 1: Write failing unit tests (no network)**

```go
// backend/internal/auth/multi_test.go
package auth_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/auth"
)

func fakeJWT(t *testing.T, payload map[string]any) string {
	t.Helper()
	hdr := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	b, err := json.Marshal(payload)
	require.NoError(t, err)
	return hdr + "." + base64.RawURLEncoding.EncodeToString(b) + ".sig"
}

func TestPeekIssuer(t *testing.T) {
	tok := fakeJWT(t, map[string]any{"iss": "https://dex.example", "sub": "x"})
	iss, err := auth.PeekIssuer(tok)
	require.NoError(t, err)
	require.Equal(t, "https://dex.example", iss)

	_, err = auth.PeekIssuer("not.a.jwt.at.all")
	require.Error(t, err)
	_, err = auth.PeekIssuer("garbage")
	require.Error(t, err)
}

func TestParseIssuersJSON(t *testing.T) {
	cfgs, err := auth.ParseIssuersJSON(`[{"issuer":"https://a","client_id":"ca"},{"issuer":"https://b","client_id":"cb"}]`)
	require.NoError(t, err)
	require.Len(t, cfgs, 2)
	require.Equal(t, "cb", cfgs[1].ClientID)

	_, err = auth.ParseIssuersJSON(`[]`)
	require.Error(t, err, "empty list must be rejected")
	_, err = auth.ParseIssuersJSON(`[{"issuer":"","client_id":"x"}]`)
	require.Error(t, err, "blank issuer must be rejected")
	_, err = auth.ParseIssuersJSON(`[{"issuer":"https://a","client_id":"x"},{"issuer":"https://a","client_id":"y"}]`)
	require.Error(t, err, "duplicate issuer must be rejected")
}

func TestMultiVerifier_UnknownIssuerRejected(t *testing.T) {
	if os.Getenv("SKIP_OIDC") != "" {
		t.Skip("SKIP_OIDC set")
	}
	ctx := context.Background()
	m, err := auth.NewMultiVerifier(ctx, []auth.IssuerConfig{{Issuer: dexIssuer(), ClientID: "kubeport"}})
	require.NoError(t, err)
	require.Equal(t, []string{dexIssuer()}, m.Issuers())

	tok := fakeJWT(t, map[string]any{"iss": "https://evil.example", "sub": "x"})
	_, err = m.Verify(ctx, tok)
	require.Error(t, err)
	require.Contains(t, err.Error(), "unknown issuer")
}

func TestMultiVerifier_RoutesToDex(t *testing.T) {
	if os.Getenv("SKIP_OIDC") != "" {
		t.Skip("SKIP_OIDC set")
	}
	ctx := context.Background()
	m, err := auth.NewMultiVerifier(ctx, []auth.IssuerConfig{
		{Issuer: dexIssuer(), ClientID: "kubeport"},
	})
	require.NoError(t, err)
	token := getDexToken(t, dexHTTPClient(t))
	claims, err := m.Verify(ctx, token)
	require.NoError(t, err)
	require.Equal(t, "alice@example.com", claims.Email)
}
```

Add to `backend/internal/auth/export_test.go`:
```go
var PeekIssuer = peekIssuer
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && go test ./internal/auth/ -run 'TestPeekIssuer|TestParseIssuersJSON|TestMultiVerifier' -v`
Expected: compile error `undefined: auth.ParseIssuersJSON` etc.

- [ ] **Step 3: Implement**

```go
// backend/internal/auth/multi.go
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
```

- [ ] **Step 4: Run tests**

Run: `cd backend && go test ./internal/auth/ -v`
Expected: all PASS (compose must be up for the dex-backed tests).

- [ ] **Step 5: Commit**

```bash
git add backend/internal/auth/multi.go backend/internal/auth/multi_test.go backend/internal/auth/export_test.go
git commit -m "feat(auth): MultiVerifier routes ID tokens to per-issuer verifiers by iss"
```

---

### Task 2: Wire `KBP_OIDC_ISSUERS` into config + server startup

**Files:**
- Modify: `backend/internal/config/config.go`
- Modify: `backend/cmd/server/main.go`
- Create: `backend/cmd/server/issuers_test.go`

**Interfaces:**
- Produces: `config.Config.OIDCIssuersJSON string`, `config.Config.DemoEmailDomain string`; helper `resolveIssuers(cfg config.Config) ([]auth.IssuerConfig, error)` in `main` package (legacy `OIDC_ISSUER`+`OIDC_AUDIENCE` still work when `KBP_OIDC_ISSUERS` is unset).

- [ ] **Step 1: Failing test**

```go
// backend/cmd/server/issuers_test.go
package main

import (
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/config"
)

func TestResolveIssuers_LegacyPair(t *testing.T) {
	got, err := resolveIssuers(config.Config{OIDCIssuer: "https://a", OIDCAudience: "kubeport"})
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, "https://a", got[0].Issuer)
	require.Equal(t, "kubeport", got[0].ClientID)
}

func TestResolveIssuers_JSONWins(t *testing.T) {
	got, err := resolveIssuers(config.Config{
		OIDCIssuer: "https://ignored", OIDCAudience: "ignored",
		OIDCIssuersJSON: `[{"issuer":"https://g","client_id":"gid"},{"issuer":"https://dex","client_id":"kubeport-demo"}]`,
	})
	require.NoError(t, err)
	require.Len(t, got, 2)
	require.Equal(t, "https://dex", got[1].Issuer)
}

func TestResolveIssuers_NothingSet(t *testing.T) {
	_, err := resolveIssuers(config.Config{})
	require.Error(t, err)
}
```

- [ ] **Step 2: Run** `cd backend && go test ./cmd/server/ -v` → FAIL `undefined: resolveIssuers`.

- [ ] **Step 3: Implement**

`backend/internal/config/config.go`:
```go
package config

type Config struct {
	ListenAddr          string
	DatabaseURL         string
	OIDCIssuer          string // legacy single issuer (kept for backwards compat)
	OIDCAudience        string // legacy single audience
	OIDCIssuersJSON     string // KBP_OIDC_ISSUERS — JSON [{issuer, client_id}]; wins over the legacy pair
	DemoEmailDomain     string // KBP_DEMO_EMAIL_DOMAIN — "" disables demo restrictions
	AppEncryptionKeyB64 string
	OpenAPICacheMax     int
}
```

`backend/cmd/server/main.go` — replace the OIDC validation + verifier construction:
```go
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
	// ... existing KBP_DEV_ADMIN_EMAILS warning stays ...

	ctx := context.Background()
	verifier, err := auth.NewMultiVerifier(ctx, issuers)
	if err != nil {
		log.Fatalf("OIDC verifier init: %v", err)
	}
	log.Printf("trusting OIDC issuers: %v", verifier.Issuers())
```
and pass `DemoEmailDomain: cfg.DemoEmailDomain` in `api.Deps` (field added in Task 3; add it here after Task 3 compiles — or do Task 3 first; either order works as long as both are committed before pushing).

Add at bottom of `main.go`:
```go
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
```
(add `"errors"` to imports.)

- [ ] **Step 4: Run** `cd backend && go test ./cmd/server/ ./internal/auth/ && go build ./...` → PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/config/config.go backend/cmd/server/main.go backend/cmd/server/issuers_test.go
git commit -m "feat(server): KBP_OIDC_ISSUERS multi-issuer config with legacy fallback"
```

---

### Task 3: Demo account restrictions (403 `demo-restricted`)

**Files:**
- Create: `backend/internal/auth/demo.go`, `backend/internal/auth/demo_test.go`
- Modify: `backend/internal/api/middleware.go`, `backend/internal/api/routes.go`, `backend/internal/api/releases.go:377-381`
- Modify: `backend/internal/api/middleware_test.go`

**Interfaces:**
- Produces: `auth.IsDemoEmail(email, domain string) bool`; `api.Deps.DemoEmailDomain string`; `denyDemo(domain string) gin.HandlerFunc` (403, type `demo-restricted`, message `demo accounts cannot perform this action`).

- [ ] **Step 1: Failing tests**

```go
// backend/internal/auth/demo_test.go
package auth_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/auth"
)

func TestIsDemoEmail(t *testing.T) {
	require.True(t, auth.IsDemoEmail("demo-user@demo.kubeport", "demo.kubeport"))
	require.True(t, auth.IsDemoEmail("Demo-Admin@DEMO.kubeport", "demo.kubeport"))
	require.False(t, auth.IsDemoEmail("alice@example.com", "demo.kubeport"))
	require.False(t, auth.IsDemoEmail("x@notdemo.kubeport", "demo.kubeport"))
	require.False(t, auth.IsDemoEmail("demo-user@demo.kubeport", ""), "empty domain disables the check")
	require.False(t, auth.IsDemoEmail("", "demo.kubeport"))
}
```

Append to `backend/internal/api/middleware_test.go`:
```go
type demoVerifier struct{ email string }

func (d demoVerifier) Verify(_ context.Context, _ string) (auth.Claims, error) {
	return auth.Claims{Subject: "demo-" + d.email, Email: d.email, Groups: []string{"kubeport-admin"}}, nil
}

func TestDenyDemo_BlocksRestrictedRoutes(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{
		Verifier: demoVerifier{email: "demo-admin@demo.kubeport"}, Store: testStore(t), DemoEmailDomain: "demo.kubeport",
	})
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/v1/clusters"},
		{http.MethodPost, "/v1/teams"},
		{http.MethodPost, "/v1/teams/00000000-0000-0000-0000-000000000000/members"},
		{http.MethodDelete, "/v1/teams/00000000-0000-0000-0000-000000000000/members/00000000-0000-0000-0000-000000000000"},
		{http.MethodDelete, "/v1/releases/00000000-0000-0000-0000-000000000000?force=true"},
	} {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(tc.method, tc.path, strings.NewReader("{}"))
		req.Header.Set("Authorization", "Bearer x")
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(w, req)
		require.Equal(t, http.StatusForbidden, w.Code, "%s %s: %s", tc.method, tc.path, w.Body.String())
		require.Contains(t, w.Body.String(), "demo-restricted")
	}
}

func TestDenyDemo_AllowsNormalRoutesAndNonDemoUsers(t *testing.T) {
	// demo user hitting an unrestricted route
	r := api.NewRouter(config.Config{}, api.Deps{
		Verifier: demoVerifier{email: "demo-user@demo.kubeport"}, Store: testStore(t), DemoEmailDomain: "demo.kubeport",
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/me", nil)
	req.Header.Set("Authorization", "Bearer x")
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)

	// non-demo admin hitting a restricted route is NOT blocked by denyDemo
	// (may fail later on validation — we only assert it is not 403 demo-restricted)
	r2 := api.NewRouter(config.Config{}, api.Deps{
		Verifier: demoVerifier{email: "root@example.com"}, Store: testStore(t), DemoEmailDomain: "demo.kubeport",
	})
	w2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodPost, "/v1/clusters", strings.NewReader("{}"))
	req2.Header.Set("Authorization", "Bearer x")
	req2.Header.Set("Content-Type", "application/json")
	r2.ServeHTTP(w2, req2)
	require.NotContains(t, w2.Body.String(), "demo-restricted")
}
```
(add `"strings"` import if missing.)

- [ ] **Step 2: Run** `cd backend && go test ./internal/auth/ ./internal/api/ -run 'TestIsDemoEmail|TestDenyDemo' -v` → FAIL (undefined).

- [ ] **Step 3: Implement**

```go
// backend/internal/auth/demo.go
package auth

import "strings"

// IsDemoEmail reports whether email belongs to the demo account domain.
// An empty domain disables demo handling entirely (returns false).
func IsDemoEmail(email, domain string) bool {
	if domain == "" || email == "" {
		return false
	}
	return strings.HasSuffix(strings.ToLower(email), "@"+strings.ToLower(domain))
}
```

`backend/internal/api/middleware.go` — append:
```go
// denyDemo returns 403 for demo-domain accounts. Mounted only on routes that
// would let a demo visitor change shared infrastructure (cluster registration,
// team management, force delete). Everything else stays governed by k8s RBAC.
func denyDemo(domain string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if domain == "" {
			c.Next()
			return
		}
		u, _ := auth.UserFrom(c.Request.Context())
		if auth.IsDemoEmail(u.Email, domain) {
			writeError(c, http.StatusForbidden, "demo-restricted", "demo accounts cannot perform this action")
			return
		}
		c.Next()
	}
}
```

`backend/internal/api/routes.go`:
```go
type Deps struct {
	Verifier        TokenVerifier
	Store           *store.Store
	K8sFactory      K8sClientFactory
	DemoEmailDomain string // "" = no demo restrictions
}
```
and in `NewRouter`:
```go
	noDemo := denyDemo(deps.DemoEmailDomain)
	v.POST("/clusters", requireAdmin(), noDemo, h.CreateCluster)
	// ...
	v.POST("/teams", requireAdmin(), noDemo, h.CreateTeam)
	v.POST("/teams/:id/members", requireAdmin(), noDemo, h.AddTeamMember)
	v.DELETE("/teams/:id/members/:user_id", requireAdmin(), noDemo, h.RemoveTeamMember)
```
`backend/internal/api/releases.go` right after `force := c.Query("force") == "true"`:
```go
	if force {
		u, _ := auth.UserFrom(c.Request.Context())
		if auth.IsDemoEmail(u.Email, h.deps.DemoEmailDomain) {
			writeError(c, http.StatusForbidden, "demo-restricted", "demo accounts cannot force-delete")
			return
		}
	}
```
`backend/cmd/server/main.go`: `api.Deps{Verifier: verifier, Store: st, K8sFactory: k8sFactory{}, DemoEmailDomain: cfg.DemoEmailDomain}`.

- [ ] **Step 4: Run** `cd backend && go test ./...` → PASS.

- [ ] **Step 5: Frontend copy for the new error type** — `frontend/messages/ko.json` and `en.json`: find the existing error-type → message map (grep `"rbac-denied"` in `frontend/messages/ko.json`) and add sibling key `"demo-restricted": "데모 계정에서는 사용할 수 없습니다."` / `"demo-restricted": "Not available for demo accounts."`. If the map lives in a component (grep `rbac-denied` in `frontend/components`), add the case there too.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/auth/demo.go backend/internal/auth/demo_test.go backend/internal/api/middleware.go backend/internal/api/middleware_test.go backend/internal/api/routes.go backend/internal/api/releases.go backend/cmd/server/main.go frontend/messages/ko.json frontend/messages/en.json
git commit -m "feat(api): deny cluster/team/force-delete for demo-domain accounts (403 demo-restricted)"
```

---

### Task 4: `sessions.provider` column (schema + sqlc + helm sync)

**Files:**
- Modify: `backend/migrations/schema.hcl` (table `sessions`), `backend/migrations/schema.sql`, `backend/internal/store/models.go` + generated queries, `deploy/helm/kubeport/files/schema.hcl`

**Interfaces:**
- Produces: column `sessions.provider text NOT NULL DEFAULT 'primary'`; `store.Session.Provider string`.

- [ ] **Step 1: Edit `schema.hcl`** — inside `table "sessions"` after `column "expires_at"` add:
```hcl
  column "provider" {
    type    = text
    null    = false
    default = "primary"
    comment = "OIDC provider key used to mint/refresh this session: primary | demo"
  }
```

- [ ] **Step 2: Apply + regenerate** (compose postgres running):
```bash
cd backend/migrations && atlas schema apply --env local --auto-approve
atlas schema inspect --env local --format '{{ sql . }}' > schema.sql
cd .. && sqlc generate
cd .. && make helm-sync
```
Expected: `store/models.go` `Session` gains `Provider string \`json:"provider"\``; `store/sessions.sql.go` `RETURNING *`/`SELECT *` scans include it. `git diff --stat` shows `schema.sql`, `models.go`, `sessions.sql.go`, `deploy/helm/kubeport/files/schema.hcl`.

- [ ] **Step 3: Verify** `cd backend && go build ./... && go test ./internal/store/... ./internal/api/...` → PASS.

- [ ] **Step 4: Helm snapshot** — `make helm-snapshot` fails (migration ConfigMap embeds schema.hcl). Run `make helm-snapshot-update`, inspect the diff is only the schema block, then `make helm-snapshot` → exit 0.

- [ ] **Step 5: Commit**
```bash
git add backend/migrations deploy/helm/kubeport/files/schema.hcl deploy/helm/kubeport/ci/snapshot.yaml backend/internal/store
git commit -m "feat(db): sessions.provider column (primary|demo) for multi-provider refresh"
```

---

### Task 5: Frontend — two OIDC providers (`primary`, `demo`)

**Files:**
- Modify: `frontend/lib/oidc.ts`, `frontend/lib/session.ts`
- Create: `frontend/lib/oidc.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Provider = "primary" | "demo";
  export function parseProvider(v: string | null | undefined): Provider; // unknown → "primary"
  export function demoEnabled(): boolean; // DEMO_OIDC_ISSUER && DEMO_OIDC_CLIENT_ID && DEMO_OIDC_CLIENT_SECRET all set
  export function providerEnv(p: Provider): { issuer: string; clientId: string; clientSecret: string; scopes: string };
  export async function getConfig(provider?: Provider): Promise<client.Configuration>; // default "primary"
  ```
  `session.ts`: `Session.provider: Provider`; `createSession(userId, idToken, refreshToken, exp, provider)`; demo sessions expire in 60 min (others keep 24 h); `getValidToken` refreshes with `getConfig(session.provider)`.
- Env (server-side only): `DEMO_OIDC_ISSUER`, `DEMO_OIDC_CLIENT_ID`, `DEMO_OIDC_CLIENT_SECRET`, `DEMO_OIDC_SCOPES` (optional), `DEMO_ADMIN_EMAIL`, `DEMO_USER_EMAIL`, `DEMO_PASSWORD_HINT` (display only).

- [ ] **Step 1: Failing unit test (vitest, pure functions)**

```ts
// frontend/lib/oidc.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseProvider, demoEnabled, providerEnv } from "./oidc";

describe("oidc providers", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("parseProvider defaults to primary", () => {
    expect(parseProvider("demo")).toBe("demo");
    expect(parseProvider("primary")).toBe("primary");
    expect(parseProvider("google")).toBe("primary");
    expect(parseProvider(null)).toBe("primary");
  });

  it("demoEnabled requires all three demo env vars", () => {
    vi.stubEnv("DEMO_OIDC_ISSUER", "https://dex.example");
    vi.stubEnv("DEMO_OIDC_CLIENT_ID", "kubeport-demo");
    vi.stubEnv("DEMO_OIDC_CLIENT_SECRET", "");
    expect(demoEnabled()).toBe(false);
    vi.stubEnv("DEMO_OIDC_CLIENT_SECRET", "s");
    expect(demoEnabled()).toBe(true);
  });

  it("providerEnv maps demo to DEMO_* and primary to OIDC_*", () => {
    vi.stubEnv("OIDC_ISSUER", "https://accounts.google.com");
    vi.stubEnv("OIDC_CLIENT_ID", "g");
    vi.stubEnv("OIDC_CLIENT_SECRET", "gs");
    vi.stubEnv("DEMO_OIDC_ISSUER", "https://dex.example");
    vi.stubEnv("DEMO_OIDC_CLIENT_ID", "kubeport-demo");
    vi.stubEnv("DEMO_OIDC_CLIENT_SECRET", "ds");
    expect(providerEnv("primary").issuer).toBe("https://accounts.google.com");
    expect(providerEnv("demo").clientId).toBe("kubeport-demo");
    expect(providerEnv("demo").scopes).toBe("openid email profile");
  });
});
```

- [ ] **Step 2: Run** `cd frontend && pnpm vitest run lib/oidc.test.ts` → FAIL (exports missing).

- [ ] **Step 3: Implement `lib/oidc.ts`**

```ts
import * as client from "openid-client";

export type Provider = "primary" | "demo";

export function parseProvider(v: string | null | undefined): Provider {
  return v === "demo" ? "demo" : "primary";
}

export function demoEnabled(): boolean {
  return Boolean(
    process.env.DEMO_OIDC_ISSUER &&
      process.env.DEMO_OIDC_CLIENT_ID &&
      process.env.DEMO_OIDC_CLIENT_SECRET,
  );
}

export function providerEnv(p: Provider) {
  if (p === "demo") {
    return {
      issuer: process.env.DEMO_OIDC_ISSUER!,
      clientId: process.env.DEMO_OIDC_CLIENT_ID!,
      clientSecret: process.env.DEMO_OIDC_CLIENT_SECRET!,
      scopes: process.env.DEMO_OIDC_SCOPES || "openid email profile",
    };
  }
  return {
    issuer: process.env.OIDC_ISSUER!,
    clientId: process.env.OIDC_CLIENT_ID!,
    clientSecret: process.env.OIDC_CLIENT_SECRET!,
    scopes: process.env.OIDC_SCOPES || "openid email profile",
  };
}

const cached: Partial<Record<Provider, client.Configuration>> = {};

export async function getConfig(provider: Provider = "primary"): Promise<client.Configuration> {
  const hit = cached[provider];
  if (hit) return hit;
  if (provider === "demo" && !demoEnabled()) {
    throw new Error("demo provider requested but DEMO_OIDC_* env is not set");
  }
  const env = providerEnv(provider);
  const opts: Parameters<typeof client.discovery>[4] =
    process.env.NODE_ENV !== "production" ? { execute: [client.allowInsecureRequests] } : undefined;
  const cfg = await client.discovery(new URL(env.issuer), env.clientId, env.clientSecret, undefined, opts);
  cached[provider] = cfg;
  return cfg;
}

export { client };
```

- [ ] **Step 4: Update `lib/session.ts`**

```ts
import type { Provider } from "./oidc";
import { getConfig, client, parseProvider } from "./oidc";

export interface Session {
  id: string;
  userId: string;
  idToken: string;
  refreshToken?: string;
  idTokenExp: Date;
  provider: Provider;
}

const SESSION_TTL_MS: Record<Provider, number> = {
  primary: 24 * 3600 * 1000,
  demo: 60 * 60 * 1000, // spec §4.1: demo sessions live 60 minutes
};

export async function createSession(
  userId: string,
  idToken: string,
  refreshToken: string | undefined,
  exp: Date,
  provider: Provider = "primary",
) {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS[provider]);
  await pool.query(
    `INSERT INTO sessions (id, user_id, id_token_encrypted, refresh_token_encrypted, id_token_exp, expires_at, provider)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, userId, encrypt(idToken), refreshToken ? encrypt(refreshToken) : null, exp, expiresAt, provider],
  );
  // cookie set unchanged except `expires: expiresAt`
  ...
}
```
In `getSession` select `provider` too and set `provider: parseProvider(rows[0].provider)`. In `getValidToken` replace `const config = await getConfig();` with `const config = await getConfig(session.provider);`.

- [ ] **Step 5: Run** `cd frontend && pnpm vitest run && pnpm lint && pnpm tsc --noEmit` → PASS (tsc surfaces every `createSession` call site — the callback route is updated in Task 6).

- [ ] **Step 6: Commit**
```bash
git add frontend/lib/oidc.ts frontend/lib/oidc.test.ts frontend/lib/session.ts
git commit -m "feat(frontend): primary/demo OIDC providers; sessions remember provider and demo TTL"
```

---

### Task 6: Login/callback with `?provider=demo&hint=<email>`

**Files:**
- Modify: `frontend/app/api/auth/login/route.ts`, `frontend/app/api/auth/callback/route.ts`

**Interfaces:**
- Consumes: `getConfig(provider)`, `providerEnv`, `parseProvider`, `demoEnabled`, `createSession(..., provider)`.
- Produces: state cookie JSON `{ state, nonce, verifier, provider }`; `GET /api/auth/login?provider=demo&hint=demo-user@demo.kubeport` → Dex authorize URL with `login_hint`. `GET /api/auth/login?provider=demo` when demo is disabled → 404 text `demo login is not enabled`.

- [ ] **Step 1: Implement login route**

```ts
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getConfig, client, parseProvider, providerEnv, demoEnabled } from "@/lib/oidc";

export async function GET(req: NextRequest) {
  const provider = parseProvider(req.nextUrl.searchParams.get("provider"));
  if (provider === "demo" && !demoEnabled()) {
    return new NextResponse("demo login is not enabled", { status: 404 });
  }
  const config = await getConfig(provider);
  const state = client.randomState();
  const nonce = client.randomNonce();
  const verifier = client.randomPKCECodeVerifier();
  const challenge = await client.calculatePKCECodeChallenge(verifier);

  const cookieStore = await cookies();
  cookieStore.set("kbp_oidc_state", JSON.stringify({ state, nonce, verifier, provider }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  const params: Record<string, string> = {
    redirect_uri: process.env.OIDC_REDIRECT_URI!,
    scope: providerEnv(provider).scopes,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
  // Dex pre-fills its login form from login_hint; only pass it for the demo
  // provider so we never leak a hint to the primary IdP.
  const hint = req.nextUrl.searchParams.get("hint");
  if (provider === "demo" && hint) params.login_hint = hint;

  const url = client.buildAuthorizationUrl(config, params);
  return NextResponse.redirect(url.href);
}
```

- [ ] **Step 2: Update callback route** — parse `provider` from the state cookie (`parseProvider(parsed.provider)`), call `getConfig(provider)` instead of `getConfig()`, and pass `provider` as the 5th argument of `createSession`. Redirect target stays `/catalog`.

- [ ] **Step 3: Manual verification against local compose dex** — in `frontend/.env.local` add:
```
DEMO_OIDC_ISSUER=https://host.docker.internal:5556
DEMO_OIDC_CLIENT_ID=kubeport
DEMO_OIDC_CLIENT_SECRET=local-dev-secret
```
(Same dex/client as primary locally; Task 10 adds the demo static users.) Start `pnpm dev`, open `http://localhost:3000/api/auth/login?provider=demo&hint=alice@example.com` → dex form shows `alice@example.com` prefilled → login → lands on `/catalog`. Check DB: `select provider, expires_at - created_at from sessions order by created_at desc limit 1;` → `demo | 01:00:00`.

- [ ] **Step 4: Run** `cd frontend && pnpm tsc --noEmit && pnpm lint && pnpm vitest run` → PASS.

- [ ] **Step 5: Commit**
```bash
git add frontend/app/api/auth/login/route.ts frontend/app/api/auth/callback/route.ts
git commit -m "feat(auth): provider-aware login/callback with Dex login_hint for demo accounts"
```

---

### Task 7: Landing page + DemoBanner + i18n

**Files:**
- Modify: `frontend/app/page.tsx`, `frontend/components/AppShell.tsx`, `frontend/messages/ko.json`, `frontend/messages/en.json`
- Create: `frontend/components/DemoBanner.tsx`, `frontend/components/DemoBanner.test.tsx`, `frontend/lib/demo.ts`, `frontend/lib/demo.test.ts`

**Interfaces:**
- Produces: `lib/demo.ts`: `isDemoEmail(email: string | null | undefined, domain = process.env.DEMO_EMAIL_DOMAIN ?? "demo.kubeport"): boolean`; `nextResetAt(now: Date, everyHours = 6): Date` (next UTC multiple of `everyHours` — matches CronJob `0 */6 * * *`).
- `DemoBanner` props: `{ resetAtIso: string }` client component; dismiss persisted in `sessionStorage["kbp_demo_banner_dismissed"]`.
- i18n keys:
  ```json
  "landing": {
    "tagline": "YAML 은 관리자가, 폼은 사용자가. Kubernetes 셀프서비스 포털.",
    "tryAdmin": "관리자로 체험", "tryUser": "사용자로 체험", "loginPrimary": "Google 로 로그인",
    "demoNote": "실제 클러스터에 배포됩니다 · 6시간마다 초기화 · 개인 데이터를 남기지 마세요",
    "demoCreds": "데모 비밀번호: {password}", "goCatalog": "카탈로그로 이동"
  },
  "demo": {
    "banner": "데모 세션입니다. 다음 초기화: {time}", "dismiss": "닫기",
    "restricted": "데모 계정에서는 사용할 수 없습니다."
  }
  ```
  (English equivalents in `en.json`: "Admins write YAML, users fill forms. A self-service portal for Kubernetes.", "Try as admin", "Try as user", "Sign in with Google", "Deploys to a real cluster · resets every 6 hours · don't leave personal data", "Demo password: {password}", "Go to catalog", "Demo session. Next reset: {time}", "Dismiss", "Not available for demo accounts.")

- [ ] **Step 1: Failing tests**

```ts
// frontend/lib/demo.test.ts
import { describe, expect, it } from "vitest";
import { isDemoEmail, nextResetAt } from "./demo";

describe("demo helpers", () => {
  it("isDemoEmail matches the demo domain case-insensitively", () => {
    expect(isDemoEmail("demo-user@demo.kubeport", "demo.kubeport")).toBe(true);
    expect(isDemoEmail("X@DEMO.KUBEPORT", "demo.kubeport")).toBe(true);
    expect(isDemoEmail("a@example.com", "demo.kubeport")).toBe(false);
    expect(isDemoEmail(null, "demo.kubeport")).toBe(false);
  });
  it("nextResetAt returns the next 6h UTC boundary", () => {
    expect(nextResetAt(new Date("2026-09-07T05:59:00Z")).toISOString()).toBe("2026-09-07T06:00:00.000Z");
    expect(nextResetAt(new Date("2026-09-07T06:00:00Z")).toISOString()).toBe("2026-09-07T12:00:00.000Z");
    expect(nextResetAt(new Date("2026-09-07T23:30:00Z")).toISOString()).toBe("2026-09-08T00:00:00.000Z");
  });
});
```

```tsx
// frontend/components/DemoBanner.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, beforeEach } from "vitest";
import { DemoBanner } from "./DemoBanner";
import ko from "@/messages/ko.json";

function renderBanner() {
  return render(
    <NextIntlClientProvider locale="ko" messages={ko}>
      <DemoBanner resetAtIso="2026-09-07T06:00:00.000Z" />
    </NextIntlClientProvider>,
  );
}

describe("DemoBanner", () => {
  beforeEach(() => sessionStorage.clear());
  it("shows the next reset time and dismisses for the session", () => {
    renderBanner();
    expect(screen.getByRole("status")).toHaveTextContent("데모 세션");
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(sessionStorage.getItem("kbp_demo_banner_dismissed")).toBe("1");
  });
});
```
(Check `frontend/vitest.config.ts`/`setup` for the existing jsdom + testing-library setup used by `RoleBadge.test.tsx`; mirror it.)

- [ ] **Step 2: Run** `cd frontend && pnpm vitest run lib/demo.test.ts components/DemoBanner.test.tsx` → FAIL.

- [ ] **Step 3: Implement**

```ts
// frontend/lib/demo.ts
export function isDemoEmail(
  email: string | null | undefined,
  domain: string = process.env.DEMO_EMAIL_DOMAIN ?? "demo.kubeport",
): boolean {
  if (!email || !domain) return false;
  return email.toLowerCase().endsWith("@" + domain.toLowerCase());
}

/** Next UTC boundary of the reset CronJob (`0 *\/6 * * *`). */
export function nextResetAt(now: Date, everyHours = 6): Date {
  const ms = everyHours * 3600 * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms + ms);
}
```

```tsx
// frontend/components/DemoBanner.tsx
"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

const KEY = "kbp_demo_banner_dismissed";

export function DemoBanner({ resetAtIso }: { resetAtIso: string }) {
  const t = useTranslations("demo");
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    try {
      setHidden(sessionStorage.getItem(KEY) === "1");
    } catch {
      setHidden(false);
    }
  }, []);
  if (hidden) return null;
  const time = new Date(resetAtIso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div role="status" className="flex items-center gap-3 border-b border-amber-300 bg-amber-50 px-6 py-2 text-sm text-amber-900">
      <span className="flex-1">{t("banner", { time })}</span>
      <button
        type="button"
        className="rounded px-2 py-0.5 hover:bg-amber-100"
        onClick={() => {
          try { sessionStorage.setItem(KEY, "1"); } catch {}
          setHidden(true);
        }}
      >
        {t("dismiss")}
      </button>
    </div>
  );
}
```
Note: `useState(true)` + effect avoids a hydration flash; the test's `fireEvent` runs after effects.

`AppShell.tsx` — after `<header>…</header>` and before `<main>`:
```tsx
{isDemoEmail(me?.email) && <DemoBanner resetAtIso={nextResetAt(new Date()).toISOString()} />}
```
with imports `import { isDemoEmail, nextResetAt } from "@/lib/demo"; import { DemoBanner } from "./DemoBanner";`.

`app/page.tsx` (server component):
```tsx
import { getTranslations } from "next-intl/server";
import { apiFetch } from "@/lib/api-server";
import { demoEnabled } from "@/lib/oidc";

export default async function Home() {
  const t = await getTranslations("landing");
  const me = await apiFetch("/v1/me").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const demo = demoEnabled();
  const adminEmail = process.env.DEMO_ADMIN_EMAIL ?? "demo-admin@demo.kubeport";
  const userEmail = process.env.DEMO_USER_EMAIL ?? "demo-user@demo.kubeport";
  const passwordHint = process.env.DEMO_PASSWORD_HINT ?? "";

  return (
    <main className="mx-auto flex max-w-2xl flex-col items-center gap-6 py-16 text-center">
      <h1 className="text-3xl font-semibold">kubeport</h1>
      <p className="text-muted-foreground">{t("tagline")}</p>
      {me ? (
        <a href="/catalog" className="rounded-md bg-primary px-4 py-2 text-primary-foreground">{t("goCatalog")}</a>
      ) : (
        <div className="flex flex-col items-center gap-3">
          {demo && (
            <div className="flex gap-3">
              <a href={`/api/auth/login?provider=demo&hint=${encodeURIComponent(adminEmail)}`} className="rounded-md border px-4 py-2 hover:bg-accent">{t("tryAdmin")}</a>
              <a href={`/api/auth/login?provider=demo&hint=${encodeURIComponent(userEmail)}`} className="rounded-md border px-4 py-2 hover:bg-accent">{t("tryUser")}</a>
            </div>
          )}
          {demo && (
            <p className="text-xs text-muted-foreground">
              {t("demoNote")}
              {passwordHint && <><br />{t("demoCreds", { password: passwordHint })}</>}
            </p>
          )}
          <a href="/api/auth/login" className="text-sm underline">{t("loginPrimary")}</a>
        </div>
      )}
    </main>
  );
}
```
Add the `landing` and `demo` blocks to both message files. Also wire the `demo-restricted` error copy from Task 3 Step 5 to `demo.restricted` if not already done.

- [ ] **Step 3b: Demo release-name suffix** (spec §4.1 리셋 — avoid 409 collisions between concurrent demo visitors). Add to `lib/demo.ts`:
```ts
/** Appends a 4-char lowercase suffix for demo users so two visitors deploying
 *  the same template with the default name don't collide on (cluster, ns, name). */
export function withDemoSuffix(name: string, isDemo: boolean, rand: () => number = Math.random): string {
  if (!isDemo) return name;
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return `${name}-${s}`;
}
```
Test in `lib/demo.test.ts`:
```ts
  it("withDemoSuffix appends 4 chars only for demo users", () => {
    expect(withDemoSuffix("web-app", false)).toBe("web-app");
    expect(withDemoSuffix("web-app", true, () => 0)).toBe("web-app-aaaa");
    expect(withDemoSuffix("web-app", true)).toMatch(/^web-app-[a-z0-9]{4}$/);
  });
```
Wire it where the deploy form computes its default release name: `grep -n "defaultValues\|name:" frontend/app/catalog/[name]/deploy/DeployClient.tsx` — find the initial value for the `name` field and wrap it as `withDemoSuffix(<current default>, isDemo)`. `DeployClient` is a client component; pass `isDemo` as a prop from `page.tsx`, which computes it server-side via `isDemoEmail(me?.email)` (page already fetches `/v1/me` or can via `apiFetch`). Vitest `DynamicForm.test.tsx`/`DeployClient` tests must still pass.

- [ ] **Step 4: Run** `cd frontend && pnpm vitest run && pnpm lint && pnpm tsc --noEmit` → PASS. Visual check on `pnpm dev`: logged-out `/` shows 2 demo buttons + Google link; logged in as a demo user shows amber banner; dismiss hides it until the tab closes; deploy form default name ends with `-xxxx`.

- [ ] **Step 5: Commit**
```bash
git add frontend/app/page.tsx frontend/components/AppShell.tsx frontend/components/DemoBanner.tsx frontend/components/DemoBanner.test.tsx frontend/lib/demo.ts frontend/lib/demo.test.ts frontend/messages/ko.json frontend/messages/en.json "frontend/app/catalog/[name]/deploy/DeployClient.tsx" "frontend/app/catalog/[name]/deploy/page.tsx"
git commit -m "feat(ui): landing with demo entry points, DemoBanner, demo release-name suffix (ko/en)"
```

---

### Task 8: `seed-demo` binary (idempotent seed + `--reset`)

**Files:**
- Create: `backend/cmd/seed-demo/main.go`, `backend/cmd/seed-demo/seed.go`, `backend/cmd/seed-demo/seed_test.go`, `backend/cmd/seed-demo/fixtures/web-app.resources.yaml`, `web-app.ui-spec.yaml`, `nightly-job.resources.yaml`, `nightly-job.ui-spec.yaml`, `app-with-config.resources.yaml`, `app-with-config.ui-spec.yaml`, `backend/cmd/seed-demo/fixtures/fixtures.go`
- Modify: `backend/Dockerfile`

**Interfaces:**
- Env: `KBP_API_BASE_URL` (e.g. `http://kubeport-backend:8080`), `DEMO_OIDC_ISSUER`, `DEMO_OIDC_CLIENT_ID`, `DEMO_OIDC_CLIENT_SECRET`, `DEMO_ADMIN_EMAIL`, `DEMO_ADMIN_PASSWORD`, `DEMO_USER_EMAIL`, `DEMO_USER_PASSWORD`, `DEMO_CLUSTER` (`oci-a1`), `DEMO_NAMESPACE` (`demo`), `DATABASE_URL` (only for `--reset`), `OIDC_CA_FILE` (local self-signed dex).
- Produces:
  ```go
  type Template struct { Name, DisplayName, Description string; Tags []string; ResourcesYAML, UISpecYAML string }
  func fixtures.All() []Template
  type Client struct { base string; http *http.Client; token string }
  func passwordGrant(ctx, issuer, clientID, clientSecret, user, pass string, hc *http.Client) (string, error)
  func (s *Seeder) Run(ctx context.Context) error          // create-if-missing templates (as admin), publish v1, create 2 releases (as user)
  func resetDB(ctx context.Context, dsn, demoDomain string) error   // deletes releases/template_versions/templates/sessions owned by demo users
  ```
  Release names are fixed (`web-app-demo`, `nightly-job-demo`) so re-runs are no-ops (409 → skip). The failing release uses image tag `ghcr.io/does-not-exist/nightly:0.0.0`.

- [ ] **Step 1: Fixtures**

`fixtures/web-app.resources.yaml`:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  replicas: 1
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: web
          image: ghcr.io/nginx/nginx-unprivileged:1.27-alpine
          ports: [{ containerPort: 8080 }]
          env:
            - name: WELCOME_MESSAGE
              value: "Hello from kubeport"
---
apiVersion: v1
kind: Service
metadata: { name: web }
spec:
  selector: { app: web }
  ports: [{ port: 80, targetPort: 8080 }]
```
`fixtures/web-app.ui-spec.yaml`:
```yaml
fields:
  - path: Deployment[web].spec.template.spec.containers[0].image
    label: "이미지 버전"
    help: "배포할 웹 서버 버전을 고릅니다."
    type: enum
    values: ["ghcr.io/nginx/nginx-unprivileged:1.27-alpine", "ghcr.io/nginx/nginx-unprivileged:1.26-alpine"]
    default: "ghcr.io/nginx/nginx-unprivileged:1.27-alpine"
  - path: Deployment[web].spec.replicas
    label: "복제 수"
    help: "동시에 실행할 인스턴스 수"
    type: integer
    min: 1
    max: 3
    default: 1
  - path: Deployment[web].spec.template.spec.containers[0].env[0].value
    label: "환영 문구"
    type: string
    default: "Hello from kubeport"
```
`fixtures/nightly-job.resources.yaml`:
```yaml
apiVersion: batch/v1
kind: CronJob
metadata: { name: nightly }
spec:
  schedule: "0 3 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: job
              image: busybox:1.36
              args: ["echo", "nightly report"]
```
`fixtures/nightly-job.ui-spec.yaml`:
```yaml
fields:
  - path: CronJob[nightly].spec.schedule
    label: "실행 주기"
    type: enum
    values: ["0 3 * * *", "0 */6 * * *", "*/5 * * * *"]
    default: "0 3 * * *"
  - path: CronJob[nightly].spec.jobTemplate.spec.template.spec.containers[0].image
    label: "이미지"
    type: string
    default: "busybox:1.36"
  - path: CronJob[nightly].spec.jobTemplate.spec.template.spec.containers[0].args[1]
    label: "출력 문구"
    type: string
    default: "nightly report"
```
`fixtures/app-with-config.resources.yaml`:
```yaml
apiVersion: v1
kind: ConfigMap
metadata: { name: app-config }
data:
  LOG_LEVEL: info
  REGION: kr
  FEATURE_FLAG: "false"
---
apiVersion: v1
kind: Secret
metadata: { name: app-secret }
type: Opaque
stringData:
  API_KEY: "change-me"
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: app }
spec:
  replicas: 1
  selector: { matchLabels: { app: app } }
  template:
    metadata: { labels: { app: app } }
    spec:
      containers:
        - name: app
          image: ghcr.io/nginx/nginx-unprivileged:1.27-alpine
          envFrom:
            - configMapRef: { name: app-config }
            - secretRef: { name: app-secret }
```
`fixtures/app-with-config.ui-spec.yaml`:
```yaml
fields:
  - path: ConfigMap[app-config].data.LOG_LEVEL
    label: "로그 레벨"
    type: enum
    values: ["debug", "info", "warn"]
    default: "info"
  - path: ConfigMap[app-config].data.REGION
    label: "리전"
    type: string
    pattern: "^[a-z]{2}$"
    default: "kr"
  - path: ConfigMap[app-config].data.FEATURE_FLAG
    label: "실험 기능"
    type: boolean
    default: false
  - path: Secret[app-secret].stringData.API_KEY
    label: "API 키"
    help: "외부 서비스 키. 데모에서는 아무 값이나 넣으세요."
    type: string
    required: true
```
> If `template.ValidateSpec` rejects the `Secret[...].stringData` path or `boolean` on a string-valued ConfigMap key, adjust to `ConfigMap[app-config].data.FEATURE_FLAG` type `enum` values `["true","false"]` — the seed test in Step 3 catches this.

`fixtures/fixtures.go`:
```go
package fixtures

import _ "embed"

//go:embed web-app.resources.yaml
var webAppResources string
//go:embed web-app.ui-spec.yaml
var webAppUISpec string
//go:embed nightly-job.resources.yaml
var nightlyResources string
//go:embed nightly-job.ui-spec.yaml
var nightlyUISpec string
//go:embed app-with-config.resources.yaml
var appCfgResources string
//go:embed app-with-config.ui-spec.yaml
var appCfgUISpec string

type Template struct {
	Name, DisplayName, Description string
	Tags                           []string
	ResourcesYAML, UISpecYAML      string
}

func All() []Template {
	return []Template{
		{Name: "web-app", DisplayName: "웹 앱", Description: "nginx 기반 웹 서버 (Deployment + Service)", Tags: []string{"web", "demo"}, ResourcesYAML: webAppResources, UISpecYAML: webAppUISpec},
		{Name: "nightly-job", DisplayName: "야간 배치", Description: "주기적으로 실행되는 CronJob", Tags: []string{"batch", "demo"}, ResourcesYAML: nightlyResources, UISpecYAML: nightlyUISpec},
		{Name: "app-with-config", DisplayName: "설정 있는 앱", Description: "ConfigMap + Secret 을 주입받는 앱", Tags: []string{"web", "config", "demo"}, ResourcesYAML: appCfgResources, UISpecYAML: appCfgUISpec},
	}
}
```

- [ ] **Step 2: Failing tests**

```go
// backend/cmd/seed-demo/seed_test.go
package main

import (
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/cmd/seed-demo/fixtures"
	"kubeport/internal/template"
)

func TestFixturesValidate(t *testing.T) {
	all := fixtures.All()
	require.Len(t, all, 3)
	for _, f := range all {
		require.NoError(t, template.ValidateSpec(f.ResourcesYAML, f.UISpecYAML), f.Name)
	}
}

func TestReleaseSpecs(t *testing.T) {
	rs := releaseSpecs()
	require.Len(t, rs, 2)
	require.Equal(t, "web-app-demo", rs[0].Name)
	require.Equal(t, "nightly-job-demo", rs[1].Name)
	require.Contains(t, string(rs[1].Values), "does-not-exist", "second release must fail to pull so the failure UX is visible")
}
```

- [ ] **Step 3: Run** `cd backend && go test ./cmd/seed-demo/ -v` → FAIL (package missing).

- [ ] **Step 4: Implement**

`backend/cmd/seed-demo/seed.go`:
```go
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"kubeport/cmd/seed-demo/fixtures"
)

type releaseSpec struct {
	Name, Template string
	Values         json.RawMessage
}

// releaseSpecs: one healthy release, one that fails to pull (bad tag) so the
// failure explainer UX is visible to demo visitors (spec §4.1 seed data).
func releaseSpecs() []releaseSpec {
	return []releaseSpec{
		{Name: "web-app-demo", Template: "web-app", Values: json.RawMessage(`{"Deployment[web].spec.replicas":1,"Deployment[web].spec.template.spec.containers[0].env[0].value":"Hello from the kubeport demo"}`)},
		{Name: "nightly-job-demo", Template: "nightly-job", Values: json.RawMessage(`{"CronJob[nightly].spec.jobTemplate.spec.template.spec.containers[0].image":"ghcr.io/does-not-exist/nightly:0.0.0"}`)},
	}
}

func passwordGrant(ctx context.Context, hc *http.Client, issuer, clientID, clientSecret, user, pass string) (string, error) {
	form := url.Values{}
	form.Set("grant_type", "password")
	form.Set("client_id", clientID)
	form.Set("client_secret", clientSecret)
	form.Set("username", user)
	form.Set("password", pass)
	form.Set("scope", "openid email profile")
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(issuer, "/")+"/token", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := hc.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("dex /token %d: %s", resp.StatusCode, b)
	}
	var out struct {
		IDToken string `json:"id_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	if out.IDToken == "" {
		return "", errors.New("dex returned no id_token")
	}
	return out.IDToken, nil
}

type apiClient struct {
	base  string
	hc    *http.Client
	token string
}

func (c *apiClient) do(ctx context.Context, method, path string, body any) (int, []byte, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, rd)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b, nil
}

type Seeder struct {
	admin, user *apiClient
	cluster, ns string
}

func (s *Seeder) Run(ctx context.Context) error {
	// 1. templates (as demo-admin). POST returns 201 or 409 (exists) — both fine.
	for _, f := range fixtures.All() {
		code, b, err := s.admin.do(ctx, http.MethodPost, "/v1/templates", map[string]any{
			"name": f.Name, "display_name": f.DisplayName, "description": f.Description, "tags": f.Tags,
			"authoring_mode": "yaml", "resources_yaml": f.ResourcesYAML, "ui_spec_yaml": f.UISpecYAML,
		})
		if err != nil {
			return err
		}
		switch code {
		case http.StatusCreated:
			log.Printf("template %s created", f.Name)
			if code, b, err := s.admin.do(ctx, http.MethodPost, "/v1/templates/"+f.Name+"/versions/1/publish", nil); err != nil || code >= 300 {
				return fmt.Errorf("publish %s: %d %s %v", f.Name, code, b, err)
			}
			// Spec §4.1: each template also ships a draft v2 so demo-admin has
			// something to edit/publish. Same YAML, draft status.
			if code, b, err := s.admin.do(ctx, http.MethodPost, "/v1/templates/"+f.Name+"/versions", map[string]any{
				"authoring_mode": "yaml", "resources_yaml": f.ResourcesYAML, "ui_spec_yaml": f.UISpecYAML,
				"notes": "데모용 초안 — 자유롭게 수정해 보세요",
			}); err != nil || code >= 300 {
				return fmt.Errorf("draft v2 %s: %d %s %v", f.Name, code, b, err)
			}
		case http.StatusConflict:
			log.Printf("template %s exists, skipping", f.Name)
		default:
			return fmt.Errorf("create template %s: %d %s", f.Name, code, b)
		}
	}
	// 2. releases (as demo-user). 201 or 409 → ok.
	for _, r := range releaseSpecs() {
		code, b, err := s.user.do(ctx, http.MethodPost, "/v1/releases", map[string]any{
			"template": r.Template, "version": 1, "cluster": s.cluster, "namespace": s.ns, "name": r.Name, "values": r.Values,
		})
		if err != nil {
			return err
		}
		switch code {
		case http.StatusCreated:
			log.Printf("release %s created", r.Name)
		case http.StatusConflict:
			log.Printf("release %s exists, skipping", r.Name)
		default:
			// The intentionally broken release may return a k8s-error after
			// apply if the cluster rejects it synchronously; log, don't fail.
			log.Printf("release %s: %d %s (continuing)", r.Name, code, b)
		}
	}
	return nil
}

var _ = time.Second
```
> Check `createVersionReq` in `templates.go:279` for the exact field names of the draft request (`notes` may differ). Templates are created as **global** (no owning team): the spec's "demo team" is dropped because Task 3 blocks demo-admin from `POST /v1/teams`, and a team adds nothing to the demo flow — record this deviation in the spec (Task 13).
> Check the actual status codes: `POST /v1/templates` on duplicate name — grep `pgUniqueViolation` in `templates.go`; if it returns 400/500 instead of 409, either fix the handler to return 409 `conflict` (preferred, add a test in `templates_test.go`) or match the real code here.

`backend/cmd/seed-demo/main.go`:
```go
package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5"

	"kubeport/internal/auth"
)

func must(k string) string {
	v := os.Getenv(k)
	if v == "" {
		log.Fatalf("%s is required", k)
	}
	return v
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	reset := flag.Bool("reset", false, "delete demo-owned rows before seeding (requires DATABASE_URL)")
	flag.Parse()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	hc := http.DefaultClient
	if ca := os.Getenv("OIDC_CA_FILE"); ca != "" {
		c, err := auth.HTTPClientFromCAFilePublic(ca)
		if err != nil {
			log.Fatal(err)
		}
		hc = c
	}

	demoDomain := getenv("KBP_DEMO_EMAIL_DOMAIN", "demo.kubeport")
	if *reset {
		if err := resetDB(ctx, must("DATABASE_URL"), demoDomain); err != nil {
			log.Fatalf("reset: %v", err)
		}
	}

	issuer, cid, csec := must("DEMO_OIDC_ISSUER"), must("DEMO_OIDC_CLIENT_ID"), must("DEMO_OIDC_CLIENT_SECRET")
	adminTok, err := passwordGrant(ctx, hc, issuer, cid, csec, must("DEMO_ADMIN_EMAIL"), must("DEMO_ADMIN_PASSWORD"))
	if err != nil {
		log.Fatalf("admin token: %v", err)
	}
	userTok, err := passwordGrant(ctx, hc, issuer, cid, csec, must("DEMO_USER_EMAIL"), must("DEMO_USER_PASSWORD"))
	if err != nil {
		log.Fatalf("user token: %v", err)
	}
	base := must("KBP_API_BASE_URL")
	s := &Seeder{
		admin:   &apiClient{base: base, hc: hc, token: adminTok},
		user:    &apiClient{base: base, hc: hc, token: userTok},
		cluster: getenv("DEMO_CLUSTER", "oci-a1"),
		ns:      getenv("DEMO_NAMESPACE", "demo"),
	}
	// Warm up users rows (GET /v1/me upserts on first sight) so team/ownership lookups work.
	for _, c := range []*apiClient{s.admin, s.user} {
		if code, b, err := c.do(ctx, http.MethodGet, "/v1/me", nil); err != nil || code != http.StatusOK {
			log.Fatalf("/v1/me: %d %s %v", code, b, err)
		}
	}
	if err := s.Run(ctx); err != nil {
		log.Fatalf("seed: %v", err)
	}
	log.Println("seed-demo: done")
}

// resetDB removes everything demo accounts own. k8s objects in the demo
// namespace are wiped by the CronJob's kubectl initContainer, not here.
func resetDB(ctx context.Context, dsn, demoDomain string) error {
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	like := "%@" + demoDomain
	stmts := []string{
		`DELETE FROM releases WHERE created_by_user_id IN (SELECT id FROM users WHERE lower(email) LIKE lower($1))`,
		`DELETE FROM template_versions WHERE template_id IN (SELECT id FROM templates WHERE owner_user_id IN (SELECT id FROM users WHERE lower(email) LIKE lower($1)))`,
		`DELETE FROM templates WHERE owner_user_id IN (SELECT id FROM users WHERE lower(email) LIKE lower($1))`,
		`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE lower(email) LIKE lower($1))`,
	}
	for _, q := range stmts {
		tag, err := conn.Exec(ctx, q, like)
		if err != nil {
			return err
		}
		log.Printf("reset: %s → %d rows", q[:30], tag.RowsAffected())
	}
	return nil
}
```
Export the CA helper for reuse: in `backend/internal/auth/verifier.go` add `// HTTPClientFromCAFilePublic is the exported form of httpClientFromCAFile for auxiliary binaries.` `func HTTPClientFromCAFilePublic(path string) (*http.Client, error) { return httpClientFromCAFile(path) }`.

`backend/Dockerfile` — build both binaries:
```dockerfile
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -ldflags="-s -w -X main.version=${VERSION}" -trimpath -o /out/server ./cmd/server && \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -ldflags="-s -w" -trimpath -o /out/seed-demo ./cmd/seed-demo
...
COPY --from=builder /out/server /server
COPY --from=builder /out/seed-demo /seed-demo
```

- [ ] **Step 5: Run unit tests** `cd backend && go test ./cmd/seed-demo/ ./internal/auth/ && go vet ./...` → PASS. Fix fixture paths if `ValidateSpec` complains.

- [ ] **Step 6: Integration run against the local stack** (docs/local-e2e.md stack up, Task 10's demo users added to local dex, `DEMO_CLUSTER=kind`, `DEMO_NAMESPACE=default`):
```bash
cd backend && DEMO_OIDC_ISSUER=https://host.docker.internal:5556 DEMO_OIDC_CLIENT_ID=kubeport DEMO_OIDC_CLIENT_SECRET=local-dev-secret \
OIDC_CA_FILE=$(pwd)/../deploy/docker/certs/dex.crt KBP_API_BASE_URL=http://localhost:8080 \
DEMO_ADMIN_EMAIL=demo-admin@demo.kubeport DEMO_ADMIN_PASSWORD=demo DEMO_USER_EMAIL=demo-user@demo.kubeport DEMO_USER_PASSWORD=demo \
DEMO_CLUSTER=kind DEMO_NAMESPACE=default go run ./cmd/seed-demo
```
Expected: 3 `template … created`, 2 `release … created`; run again → all `exists, skipping`. Then `--reset` with `DATABASE_URL` → rows deleted then recreated. Backend must run with `KBP_DEV_ADMIN_EMAILS=admin@example.com,demo-admin@demo.kubeport` and `KBP_DEMO_EMAIL_DOMAIN=demo.kubeport`.

- [ ] **Step 7: Commit**
```bash
git add backend/cmd/seed-demo backend/internal/auth/verifier.go backend/Dockerfile
git commit -m "feat(seed-demo): idempotent demo seed (3 templates, 2 releases) with --reset"
```

---

### Task 9: Helm — Dex + demo namespace policy + reset CronJob + env wiring

**Files:**
- Create: `deploy/helm/kubeport/templates/dex-configmap.yaml`, `dex-secret.yaml`, `dex-deployment.yaml`, `dex-service.yaml`, `dex-ingress.yaml`, `dex-certificate.yaml`, `demo-namespace.yaml`, `demo-rbac.yaml`, `demo-reset-cronjob.yaml`
- Modify: `values.yaml`, `values-oci-phase2.yaml`, `templates/_helpers.tpl`, `templates/backend-configmap.yaml`, `templates/frontend-configmap.yaml`, `templates/secret.yaml`, `ci/test-values.yaml`, `ci/snapshot.yaml`, `README.md`

**Interfaces:**
- Values:
```yaml
dex:
  enabled: false
  host: ""                       # e.g. dex.kubeport.enzo.kr (required when enabled)
  image: ghcr.io/dexidp/dex:v2.39.0
  clientId: kubeport-demo
  clientSecret: ""               # --set, never commit
  # bcrypt hashes: htpasswd -bnBC 10 "" '<pw>' | tr -d ':\n'
  staticPasswords:
    - email: demo-admin@demo.kubeport
      username: demo-admin
      userID: demo-admin-000
      hash: ""
    - email: demo-user@demo.kubeport
      username: demo-user
      userID: demo-user-000
      hash: ""
  resources: { requests: { cpu: 20m, memory: 64Mi }, limits: { cpu: 200m, memory: 128Mi } }

demo:
  enabled: false                 # namespace + quota + RBAC + reset CronJob
  namespace: demo
  emailDomain: demo.kubeport
  adminEmail: demo-admin@demo.kubeport
  userEmail: demo-user@demo.kubeport
  passwordHint: ""               # shown on landing (public by design)
  adminPassword: ""              # --set; used by the reset job only
  userPassword: ""
  cluster: oci-a1
  resetSchedule: "0 */6 * * *"
  kubectlImage: bitnami/kubectl:1.31
  usernamePrefix: "dex:"         # must match k3s AuthenticationConfiguration
```
- Rendered env: backend ConfigMap gets `KBP_OIDC_ISSUERS` (JSON of primary + dex when `dex.enabled`) and `KBP_DEMO_EMAIL_DOMAIN`; `KBP_DEV_ADMIN_EMAILS` gets `demo.adminEmail` appended when `demo.enabled`. Frontend ConfigMap gets `DEMO_OIDC_ISSUER`, `DEMO_OIDC_CLIENT_ID`, `DEMO_ADMIN_EMAIL`, `DEMO_USER_EMAIL`, `DEMO_PASSWORD_HINT`, `DEMO_EMAIL_DOMAIN`; the auth Secret gets `DEMO_OIDC_CLIENT_SECRET`.

- [ ] **Step 1: Helpers** — append to `_helpers.tpl`:
```tpl
{{- define "kubeport.dex.fullname" -}}
{{- printf "%s-dex" (include "kubeport.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kubeport.dex.issuer" -}}
{{- printf "https://%s" (required "dex.host is required when dex.enabled" .Values.dex.host) -}}
{{- end -}}

{{/* JSON array for KBP_OIDC_ISSUERS: primary + (optional) dex */}}
{{- define "kubeport.oidcIssuersJSON" -}}
{{- $list := list (dict "issuer" .Values.oidc.issuer "client_id" .Values.oidc.audience) -}}
{{- if .Values.dex.enabled -}}
{{- $list = append $list (dict "issuer" (include "kubeport.dex.issuer" .) "client_id" .Values.dex.clientId) -}}
{{- end -}}
{{- $list | toJson -}}
{{- end -}}

{{/* KBP_DEV_ADMIN_EMAILS with demo admin appended when demo is enabled */}}
{{- define "kubeport.devAdminEmails" -}}
{{- $emails := .Values.auth.devAdminEmails -}}
{{- if .Values.demo.enabled -}}
{{- $emails = ternary .Values.demo.adminEmail (printf "%s,%s" $emails .Values.demo.adminEmail) (eq $emails "") -}}
{{- end -}}
{{- $emails -}}
{{- end -}}
```

- [ ] **Step 2: Backend ConfigMap** — replace the `OIDC_ISSUER`/`OIDC_AUDIENCE`/`KBP_DEV_ADMIN_EMAILS` lines with:
```yaml
  OIDC_ISSUER: {{ required "oidc.issuer is required" .Values.oidc.issuer | quote }}
  OIDC_AUDIENCE: {{ required "oidc.audience is required" .Values.oidc.audience | quote }}
  KBP_OIDC_ISSUERS: {{ include "kubeport.oidcIssuersJSON" . | quote }}
  {{- if .Values.demo.enabled }}
  KBP_DEMO_EMAIL_DOMAIN: {{ .Values.demo.emailDomain | quote }}
  {{- end }}
  {{- with include "kubeport.devAdminEmails" . }}
  KBP_DEV_ADMIN_EMAILS: {{ . | quote }}
  {{- end }}
```
**Frontend ConfigMap** — append:
```yaml
  {{- if .Values.dex.enabled }}
  DEMO_OIDC_ISSUER: {{ include "kubeport.dex.issuer" . | quote }}
  DEMO_OIDC_CLIENT_ID: {{ .Values.dex.clientId | quote }}
  DEMO_EMAIL_DOMAIN: {{ .Values.demo.emailDomain | quote }}
  DEMO_ADMIN_EMAIL: {{ .Values.demo.adminEmail | quote }}
  DEMO_USER_EMAIL: {{ .Values.demo.userEmail | quote }}
  {{- with .Values.demo.passwordHint }}
  DEMO_PASSWORD_HINT: {{ . | quote }}
  {{- end }}
  {{- end }}
```
**Auth Secret** (`templates/secret.yaml`, inside the `auth.create` block): `{{- if .Values.dex.enabled }} DEMO_OIDC_CLIENT_SECRET: {{ required "dex.clientSecret is required" .Values.dex.clientSecret | b64enc | quote }} {{- end }}`. Document in `values.yaml` that an external Secret must also carry `DEMO_OIDC_CLIENT_SECRET` when dex is enabled.

- [ ] **Step 3: Dex templates** (all wrapped in `{{- if .Values.dex.enabled }}`):

`dex-configmap.yaml` data `config.yaml`:
```yaml
issuer: {{ include "kubeport.dex.issuer" . }}
storage: { type: memory }
web: { http: 0.0.0.0:5556 }
oauth2: { passwordConnector: local, skipApprovalScreen: true }
enablePasswordDB: true
staticClients:
  - id: {{ .Values.dex.clientId }}
    name: kubeport demo
    secretEnv: DEX_CLIENT_SECRET
    redirectURIs:
      - {{ include "kubeport.oidc.redirectUri" . }}
staticPasswords:
{{- range .Values.dex.staticPasswords }}
  - email: {{ .email | quote }}
    username: {{ .username | quote }}
    userID: {{ .userID | quote }}
    hash: {{ required "dex.staticPasswords[].hash is required" .hash | quote }}
{{- end }}
```
`dex-secret.yaml`: Secret `{{ dex.fullname }}` with `DEX_CLIENT_SECRET`. `dex-deployment.yaml`: 1 replica, image `.Values.dex.image`, `command: ["dex","serve","/etc/dex/config.yaml"]`, ConfigMap mounted at `/etc/dex`, env from dex Secret, port 5556, readiness `GET /healthz`, same `podSecurityContext`/`securityContext` as backend, resources from values. `dex-service.yaml`: ClusterIP 5556. `dex-ingress.yaml`: host `.Values.dex.host`, className from `.Values.ingress.className`, annotations from `.Values.ingress.annotations`, TLS secret `{{ dex.fullname }}-tls`. `dex-certificate.yaml`: like `certificate.yaml` for `dex.host` (guarded by `tls.certManager.enabled`).

> `skipApprovalScreen: true` removes the "Grant Access" click for demo visitors. The e2e fixture already treats that button as optional.

- [ ] **Step 4: Demo namespace policy** (`{{- if .Values.demo.enabled }}`), `demo-namespace.yaml`:
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: {{ .Values.demo.namespace }}
  labels: { kubeport.io/demo: "true" }
---
apiVersion: v1
kind: ResourceQuota
metadata: { name: demo-quota, namespace: {{ .Values.demo.namespace }} }
spec:
  hard:
    requests.cpu: "1"
    requests.memory: 2Gi
    pods: "10"
    services: "5"
    services.loadbalancers: "0"
    count/ingresses.networking.k8s.io: "0"
---
apiVersion: v1
kind: LimitRange
metadata: { name: demo-limits, namespace: {{ .Values.demo.namespace }} }
spec:
  limits:
    - type: Container
      default: { cpu: 500m, memory: 512Mi }
      defaultRequest: { cpu: 100m, memory: 128Mi }
      max: { cpu: 500m, memory: 512Mi }
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: demo-egress, namespace: {{ .Values.demo.namespace }} }
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - to: [{ namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: kube-system } } }]
      ports: [{ protocol: UDP, port: 53 }, { protocol: TCP, port: 53 }]
    - to: [{ ipBlock: { cidr: 0.0.0.0/0, except: [10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16] } }]
```
`demo-rbac.yaml`:
```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: demo-admin, namespace: {{ .Values.demo.namespace }} }
rules:
  - apiGroups: ["", "apps", "batch", "networking.k8s.io"]
    resources: ["*"]
    verbs: ["*"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: demo-user, namespace: {{ .Values.demo.namespace }} }
rules:
  - apiGroups: ["", "apps", "batch"]
    resources: ["pods", "pods/log", "services", "configmaps", "deployments", "statefulsets", "jobs", "cronjobs", "events", "replicasets"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["create", "update", "patch", "delete"]   # no get/list: users can write but not read back secrets
  - apiGroups: ["authorization.k8s.io"]
    resources: ["selfsubjectaccessreviews"]
    verbs: ["create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: demo-admin, namespace: {{ .Values.demo.namespace }} }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: demo-admin }
subjects: [{ kind: User, name: {{ printf "%s%s" .Values.demo.usernamePrefix .Values.demo.adminEmail | quote }} }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: demo-user, namespace: {{ .Values.demo.namespace }} }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: demo-user }
subjects: [{ kind: User, name: {{ printf "%s%s" .Values.demo.usernamePrefix .Values.demo.userEmail | quote }} }]
---
# SelfSubjectAccessReview is cluster-scoped; demo users need it for the RBAC panel.
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: {{ include "kubeport.fullname" . }}-demo-ssar }
rules:
  - apiGroups: ["authorization.k8s.io"]
    resources: ["selfsubjectaccessreviews"]
    verbs: ["create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: {{ include "kubeport.fullname" . }}-demo-ssar }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: {{ include "kubeport.fullname" . }}-demo-ssar }
subjects:
  - { kind: User, name: {{ printf "%s%s" .Values.demo.usernamePrefix .Values.demo.adminEmail | quote }} }
  - { kind: User, name: {{ printf "%s%s" .Values.demo.usernamePrefix .Values.demo.userEmail | quote }} }
```
> Verify against `backend/internal/k8s/access.go` and the OpenAPI proxy which cluster-scoped calls the app makes for non-admin users (`/openapi/v3` discovery is served to any authenticated user by default via `system:discovery`; if the RBAC panel or KindPicker needs more, add it here — the e2e in Task 10 will surface it).

`demo-reset-cronjob.yaml`:
```yaml
apiVersion: v1
kind: ServiceAccount
metadata: { name: demo-reset, namespace: {{ .Release.Namespace }} }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: demo-reset, namespace: {{ .Values.demo.namespace }} }
rules:
  - apiGroups: ["", "apps", "batch", "networking.k8s.io"]
    resources: ["*"]
    verbs: ["get", "list", "delete", "deletecollection"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: demo-reset, namespace: {{ .Values.demo.namespace }} }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: demo-reset }
subjects: [{ kind: ServiceAccount, name: demo-reset, namespace: {{ .Release.Namespace }} }]
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: {{ include "kubeport.fullname" . }}-demo-reset
  labels: {{- include "kubeport.labels" . | nindent 4 }}
spec:
  schedule: {{ .Values.demo.resetSchedule | quote }}
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 1
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 1
      activeDeadlineSeconds: 600
      template:
        spec:
          serviceAccountName: demo-reset
          restartPolicy: Never
          securityContext: {{- toYaml .Values.podSecurityContext | nindent 12 }}
          initContainers:
            - name: wipe-k8s
              image: {{ .Values.demo.kubectlImage }}
              command: ["sh", "-c"]
              args:
                - kubectl -n {{ .Values.demo.namespace }} delete deploy,sts,ds,job,cronjob,svc,cm,secret,pod --all --wait=false --ignore-not-found
              securityContext: {{- toYaml .Values.securityContext | nindent 16 }}
          containers:
            - name: seed
              image: {{ include "kubeport.backend.image" . }}
              command: ["/seed-demo", "--reset"]
              envFrom:
                - secretRef: { name: {{ include "kubeport.auth.secretName" . } }
              env:
                - { name: KBP_API_BASE_URL, value: {{ printf "http://%s:%v" (include "kubeport.backend.fullname" .) .Values.backend.service.port | quote } }
                - { name: DEMO_OIDC_ISSUER, value: {{ include "kubeport.dex.issuer" . | quote } }
                - { name: DEMO_OIDC_CLIENT_ID, value: {{ .Values.dex.clientId | quote } }
                - { name: DEMO_ADMIN_EMAIL, value: {{ .Values.demo.adminEmail | quote } }
                - { name: DEMO_USER_EMAIL, value: {{ .Values.demo.userEmail | quote } }
                - { name: DEMO_CLUSTER, value: {{ .Values.demo.cluster | quote } }
                - { name: DEMO_NAMESPACE, value: {{ .Values.demo.namespace | quote } }
                - { name: KBP_DEMO_EMAIL_DOMAIN, value: {{ .Values.demo.emailDomain | quote } }
                - name: DEMO_ADMIN_PASSWORD
                  valueFrom: { secretKeyRef: { name: {{ include "kubeport.fullname" . }}-demo, key: DEMO_ADMIN_PASSWORD } }
                - name: DEMO_USER_PASSWORD
                  valueFrom: { secretKeyRef: { name: {{ include "kubeport.fullname" . }}-demo, key: DEMO_USER_PASSWORD } }
              securityContext: {{- toYaml .Values.securityContext | nindent 16 }}
---
apiVersion: v1
kind: Secret
metadata: { name: {{ include "kubeport.fullname" . }}-demo }
type: Opaque
data:
  DEMO_ADMIN_PASSWORD: {{ required "demo.adminPassword is required" .Values.demo.adminPassword | b64enc | quote }}
  DEMO_USER_PASSWORD: {{ required "demo.userPassword is required" .Values.demo.userPassword | b64enc | quote }}
```
`DEMO_OIDC_CLIENT_SECRET` and `DATABASE_URL` come from the auth Secret via `envFrom`. Note the `secret` wipe also removes the k8s Secret objects created by releases — intended. Wildcard `kubectl delete ... --all` is namespace-scoped by the Role, so a misconfigured job cannot touch other namespaces.

- [ ] **Step 5: values + CI values** — add the `dex:` and `demo:` blocks to `values.yaml` (defaults `enabled: false`). In `values-oci-phase2.yaml` add:
```yaml
dex:
  enabled: true
  host: dex.kubeport.enzo.kr
  clientSecret: ""             # --set dex.clientSecret=$(openssl rand -hex 24)
  staticPasswords:             # hashes via: htpasswd -bnBC 10 "" "$DEMO_PW" | tr -d ':\n'
    - { email: demo-admin@demo.kubeport, username: demo-admin, userID: demo-admin-000, hash: "" }
    - { email: demo-user@demo.kubeport,  username: demo-user,  userID: demo-user-000,  hash: "" }
demo:
  enabled: true
  cluster: oci-a1
  passwordHint: ""             # --set demo.passwordHint=$DEMO_PW  (public)
  adminPassword: ""            # --set
  userPassword: ""             # --set
```
In `ci/test-values.yaml` enable both with dummy `host: dex.example.test`, `clientSecret: test`, hashes `"$2y$10$wvTSwatbRSSK8WDYkH70LeiRigmZqFsJlz2.8miz8fNrzOm5kFJDG"` (password `demo`), passwords `demo` so the golden snapshot covers the templates. Leave `ci/smoke-values.yaml` with both disabled (kind smoke doesn't have cert-manager).

- [ ] **Step 6: Lint + snapshot**
```bash
make helm-lint && make helm-snapshot-update && git diff --stat deploy/helm/kubeport/ci/snapshot.yaml && make helm-snapshot
```
Expected: lint clean; snapshot shows the new Dex/demo objects, `KBP_OIDC_ISSUERS` JSON with two entries, `KBP_DEV_ADMIN_EMAILS` containing `demo-admin@demo.kubeport`; second `make helm-snapshot` exits 0. Also render with defaults (`helm template kp deploy/helm/kubeport --set oidc.issuer=https://x --set oidc.clientId=y --set postgres.password=z --set auth.appEncryptionKeyB64=a --set auth.oidcClientSecret=b`) and confirm **no** dex/demo objects and `KBP_OIDC_ISSUERS` has one entry.

- [ ] **Step 7: Chart README** — add a "Demo mode (Dex)" section: values, hash generation command, what the reset job does, that `dex.host` needs a DNS record and that k3s must trust the Dex issuer (link to `deploy/oci/README.md §7.6`).

- [ ] **Step 8: Commit**
```bash
git add deploy/helm/kubeport
git commit -m "feat(helm): optional Dex demo IdP, demo namespace policy/RBAC, and 6h reset CronJob"
```

---

### Task 10: Local dev parity + e2e demo fixtures + smoke spec

> **Carried to Plan 11**: the deploy→release→logs happy path and the admin
> new-version authoring scenario are *not* covered by `04-demo-user.spec.ts`
> here — they need a live cluster and are folded into Plan 11's e2e expansion
> against the live OCI deploy.

**Files:**
- Modify: `deploy/docker/dex.yaml`, `docs/local-e2e.md`, `frontend/tests/e2e/fixtures.ts`
- Create: `frontend/tests/e2e/04-demo-user.spec.ts`

**Interfaces:**
- Produces: `demoAdminStorage()`, `demoUserStorage()` in fixtures (login via `/api/auth/login?provider=demo&hint=<email>`); local demo password `demo`.

- [ ] **Step 1: Local dex users** — append to `deploy/docker/dex.yaml` `staticPasswords`:
```yaml
  - email: demo-admin@demo.kubeport
    hash: "<bcrypt of 'demo'>"   # htpasswd -bnBC 10 "" demo | tr -d ':\n'
    username: demo-admin
    userID: "demo-admin-000"
  - email: demo-user@demo.kubeport
    hash: "<bcrypt of 'demo'>"
    username: demo-user
    userID: "demo-user-000"
```
Generate the hash once and paste the literal (comment `# password: demo`). Restart compose: `docker compose -f deploy/docker/docker-compose.yml restart dex`.

- [ ] **Step 2: `docs/local-e2e.md`** — in the backend env block add `KBP_DEMO_EMAIL_DOMAIN=demo.kubeport` and extend `KBP_DEV_ADMIN_EMAILS` with `demo-admin@demo.kubeport`; in the frontend `.env.local` block add the three `DEMO_OIDC_*` lines (same dex/client as primary) plus `DEMO_PASSWORD_HINT=demo`; add a "Seed demo data" subsection with the `go run ./cmd/seed-demo` command from Task 8 Step 6; add the kind RBAC for demo users (kind trusts dex with no username prefix locally, so bind raw emails):
```bash
kubectl create rolebinding demo-admin --clusterrole=admin --user=demo-admin@demo.kubeport -n default
kubectl create rolebinding demo-user  --clusterrole=edit  --user=demo-user@demo.kubeport  -n default
```
Also update the `playwright.yml` CI setup step that warms `/v1/me` so it warms the two demo users too (grep `alice@example.com` in `.github/workflows/playwright.yml`).

- [ ] **Step 3: Fixtures** — in `fixtures.ts` generalize `loginAs(email, password, stateFile, provider: "primary" | "demo" = "primary")` to open `` `${BASE_URL}/api/auth/login${provider === "demo" ? `?provider=demo&hint=${encodeURIComponent(email)}` : ""}` `` and add:
```ts
export async function demoAdminStorage(): Promise<string> {
  const p = "tests/e2e/.auth/demo-admin.json";
  await loginAs("demo-admin@demo.kubeport", "demo", p, "demo");
  return p;
}
export async function demoUserStorage(): Promise<string> {
  const p = "tests/e2e/.auth/demo-user.json";
  await loginAs("demo-user@demo.kubeport", "demo", p, "demo");
  return p;
}
```

- [ ] **Step 4: Smoke spec**
```ts
// frontend/tests/e2e/04-demo-user.spec.ts
import { test, expect, demoUserStorage, demoAdminStorage } from "./fixtures";

test.describe("demo user", () => {
  test.use({ storageState: async ({}, use) => use(await demoUserStorage()) });

  test("sees the demo banner and the seeded catalog", async ({ page }) => {
    await page.goto("/catalog");
    await expect(page.getByRole("status")).toContainText(/데모 세션|Demo session/);
    await expect(page.getByText("웹 앱")).toBeVisible();
    await expect(page.getByText("야간 배치")).toBeVisible();
  });

  test("landing shows 'go to catalog' when logged in", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: /카탈로그로 이동|Go to catalog/ })).toBeVisible();
  });
});

test.describe("demo admin restrictions", () => {
  test.use({ storageState: async ({}, use) => use(await demoAdminStorage()) });

  test("cannot create a team", async ({ page, request }) => {
    const res = await request.post("/api/v1/teams", { data: { name: "should-fail", display_name: "x" } });
    expect(res.status()).toBe(403);
    expect(await res.text()).toContain("demo-restricted");
  });
});

test.describe("logged out landing", () => {
  test("shows demo entry buttons", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/");
    await expect(page.getByRole("link", { name: /관리자로 체험|Try as admin/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /사용자로 체험|Try as user/ })).toBeVisible();
    await ctx.close();
  });
});
```
The full user deploy flow (form → release → logs) is Plan 11's scope; this spec only proves login, seed visibility, banner and restriction.

- [ ] **Step 5: Run** — with the local stack up and seed applied: `cd frontend && pnpm test:e2e tests/e2e/04-demo-user.spec.ts` → 4 passed. Then run the whole suite `pnpm test:e2e` to confirm existing specs still pass (dex users unchanged).

- [ ] **Step 6: Commit**
```bash
git add deploy/docker/dex.yaml docs/local-e2e.md frontend/tests/e2e/fixtures.ts frontend/tests/e2e/04-demo-user.spec.ts .github/workflows/playwright.yml
git commit -m "test(e2e): demo account fixtures and smoke; local dex demo users"
```

---

### Task 11: k3s structured authentication cutover script (Google + Dex)

**Files:**
- Create: `deploy/oci/k3s-auth-config.sh`
- Modify: `deploy/oci/bootstrap.sh` (lines ~81–97), `deploy/oci/README.md` (§7.1, new §7.6), `docs/oci-prod-runbook.md` (§5-1, §5-3, §8)

**Interfaces:**
- Script env: `GOOGLE_CLIENT_ID` (required), `DEX_ISSUER` (default `https://dex.kubeport.enzo.kr`), `DEX_CLIENT_ID` (default `kubeport-demo`), `DEX_USERNAME_PREFIX` (default `dex:`), `ROLLBACK=1` to restore the previous flags. Writes `/etc/rancher/k3s/auth.yaml` + `/etc/rancher/k3s/config.yaml`, keeps `config.yaml.bak`, restarts k3s, verifies `/readyz`, auto-rolls back on failure.

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# deploy/oci/k3s-auth-config.sh — switch k3s apiserver from --oidc-* flags to a
# structured AuthenticationConfiguration trusting Google + Dex.
# Run ON THE VM as a sudoer. Idempotent. ROLLBACK=1 restores config.yaml.bak.
set -euo pipefail

CFG=/etc/rancher/k3s/config.yaml
AUTH=/etc/rancher/k3s/auth.yaml
DEX_ISSUER="${DEX_ISSUER:-https://dex.kubeport.enzo.kr}"
DEX_CLIENT_ID="${DEX_CLIENT_ID:-kubeport-demo}"
DEX_USERNAME_PREFIX="${DEX_USERNAME_PREFIX:-dex:}"

restart_and_verify() {
  sudo systemctl restart k3s
  for i in $(seq 1 30); do
    if sudo k3s kubectl get --raw=/readyz 2>/dev/null | grep -q ok; then echo "apiserver ready"; return 0; fi
    sleep 2
  done
  return 1
}

if [[ "${ROLLBACK:-0}" == "1" ]]; then
  echo "rolling back to ${CFG}.bak"
  sudo cp "${CFG}.bak" "$CFG"
  restart_and_verify
  exit $?
fi

: "${GOOGLE_CLIENT_ID:?GOOGLE_CLIENT_ID is required}"

# Structured auth is GA (v1) on k8s >= 1.34, beta (v1beta1) on 1.30–1.33.
MINOR=$(sudo k3s kubectl version -o json | python3 -c 'import sys,json;print(int(json.load(sys.stdin)["serverVersion"]["minor"].rstrip("+")))')
if (( MINOR >= 34 )); then API=apiserver.config.k8s.io/v1; elif (( MINOR >= 30 )); then API=apiserver.config.k8s.io/v1beta1; else echo "k8s 1.$MINOR too old for structured auth"; exit 1; fi

# The apiserver must be able to fetch ${DEX_ISSUER}/.well-known/openid-configuration.
curl -fsS "${DEX_ISSUER}/.well-known/openid-configuration" >/dev/null || { echo "dex discovery unreachable from the node"; exit 1; }

sudo cp -n "$CFG" "${CFG}.bak" 2>/dev/null || true
sudo tee "$AUTH" >/dev/null <<EOF
apiVersion: ${API}
kind: AuthenticationConfiguration
jwt:
  - issuer:
      url: https://accounts.google.com
      audiences: ["${GOOGLE_CLIENT_ID}"]
    claimMappings:
      username: { claim: email, prefix: "" }
  - issuer:
      url: ${DEX_ISSUER}
      audiences: ["${DEX_CLIENT_ID}"]
    claimMappings:
      username: { claim: email, prefix: "${DEX_USERNAME_PREFIX}" }
EOF

# Replace ALL oidc-* args — they cannot coexist with authentication-config.
sudo tee "$CFG" >/dev/null <<EOF
kube-apiserver-arg:
  - "authentication-config=${AUTH}"
EOF

if restart_and_verify; then
  echo "structured auth active: Google + ${DEX_ISSUER}"
else
  echo "apiserver did not become ready — rolling back"
  sudo cp "${CFG}.bak" "$CFG"; restart_and_verify; exit 1
fi
```
> If the existing `config.yaml` carries non-OIDC keys (check with `cat` before running), merge them into the heredoc instead of overwriting.

- [ ] **Step 2: bootstrap.sh** — replace the `oidc-*` heredoc block with: when `BOOTSTRAP_OIDC_CLIENT_ID` is set, write `auth.yaml` with the Google issuer only (same structure, `${API}` detection can't run pre-install → use `v1beta1` when `INSTALL_K3S_CHANNEL`/version < 1.34 else `v1`; simplest: default `apiserver.config.k8s.io/v1` and document the override env `BOOTSTRAP_AUTH_API`), and `config.yaml` with `authentication-config=/etc/rancher/k3s/auth.yaml`. Dex is added later by `k3s-auth-config.sh` (it needs the Dex ingress up first). Keep the YAML-quoting warning comment.

- [ ] **Step 3: Docs** — `deploy/oci/README.md`: rewrite §7.1 to the structured-auth form, add §7.6 "Demo IdP (Dex) 신뢰 추가": prerequisites (DNS `dex.kubeport.enzo.kr` → public IP, helm upgrade with `dex.enabled=true` done, cert issued), run `k3s-auth-config.sh`, verify with a Dex token:
```bash
TOKEN=$(curl -s -X POST https://dex.kubeport.enzo.kr/token -d grant_type=password -d client_id=kubeport-demo -d client_secret=$DEX_SECRET -d username=demo-user@demo.kubeport -d password=$DEMO_PW -d scope='openid email' | jq -r .id_token)
kubectl --token="$TOKEN" auth whoami          # → dex:demo-user@demo.kubeport
kubectl --token="$TOKEN" -n demo auth can-i create deployments   # yes
kubectl --token="$TOKEN" -n default auth can-i create deployments # no
```
`docs/oci-prod-runbook.md`: §5-1 → structured auth + rollback command (`ROLLBACK=1 bash k3s-auth-config.sh`); §5-3 → remove the cluster-admin demo binding instruction, state "owner email keeps cluster-admin; demo users are namespace-scoped via the chart"; §8 → strike "RBAC 스코프 축소" as done for demo users. Add a §7 row: "데모 로그인 후 배포 401/403 → k3s auth.yaml 에 Dex issuer 있는지, prefix `dex:` 와 RoleBinding subject 일치하는지".

- [ ] **Step 4: Shell lint** — `bash -n deploy/oci/k3s-auth-config.sh deploy/oci/bootstrap.sh`; if `shellcheck` is available run it.

- [ ] **Step 5: Commit**
```bash
git add deploy/oci/k3s-auth-config.sh deploy/oci/bootstrap.sh deploy/oci/README.md docs/oci-prod-runbook.md
git commit -m "feat(oci): k3s structured authentication (Google + Dex) cutover script with rollback"
```

---

### Task 12: Production rollout (human-executed checklist)

**Files:** none (operational). Record outcomes in `docs/oci-prod-runbook.md` §5 once done.

Order matters: Dex must be reachable before k3s trusts it, and the backend must trust Dex before the frontend offers demo login.

- [ ] **Step 1: DNS** — Cloudflare A record `dex.kubeport.enzo.kr` → current public IP (ephemeral; note in runbook).
- [ ] **Step 2: Secrets** — generate once and store in the password manager:
```bash
# Shown publicly and copied by eye, so the alphabet drops the confusables
# 0 O 1 l I — base64 emits all of them (#132). 32 chars x 10 = 50 bits.
DEMO_PW=$(LC_ALL=C tr -dc '23456789ABCDEFGHJKLMNPQRSTUVWXYZ' < /dev/urandom | head -c 10)
DEX_SECRET=$(openssl rand -hex 24)
HASH=$(htpasswd -bnBC 10 "" "$DEMO_PW" | tr -d ':\n')
```
- [ ] **Step 3: helm upgrade** (from the VM, chart copy per runbook §3). `values-oci-phase2.yaml` ships `dex.enabled: false` / `demo.enabled: false` on purpose (so routine upgrades never need these secrets), so this **first** flip must pass the full `--set` list. Afterwards `--reuse-values` carries them and later upgrades only need the image tags:
```bash
helm upgrade kubeport ~/kubeport-chart/kubeport -n kubeport --reuse-values \
  -f ~/kubeport-chart/kubeport/values-oci-phase2.yaml \
  --set images.backend.tag=$NEW_SHA --set images.frontend.tag=$NEW_SHA \
  --set dex.enabled=true --set dex.host=dex.kubeport.enzo.kr --set dex.clientSecret=$DEX_SECRET \
  --set "dex.staticPasswords[0].hash=$HASH" --set "dex.staticPasswords[1].hash=$HASH" \
  --set demo.enabled=true --set demo.passwordHint=$DEMO_PW --set demo.adminPassword=$DEMO_PW --set demo.userPassword=$DEMO_PW
kubectl -n kubeport get certificate   # wait for kubeport-dex Ready
curl -s https://dex.kubeport.enzo.kr/.well-known/openid-configuration | jq .issuer
# from INSIDE the cluster too — the backend is what has to reach Dex:
kubectl -n kubeport exec deploy/kubeport-backend -- \
  wget -qO- https://dex.kubeport.enzo.kr/.well-known/openid-configuration | head -c 200
```
> Two-phase note: the backend does OIDC discovery **lazily** per issuer, so flipping `KBP_OIDC_ISSUERS` before Dex is up no longer crashes it — it logs `WARN: issuer … discovery failed` and 401s Dex tokens until Dex answers. Still bring Dex + its Certificate `Ready` up first and confirm the in-cluster reachability above before announcing demo login.
- [ ] **Step 4: k3s trust** — `GOOGLE_CLIENT_ID=… bash k3s-auth-config.sh` then the `kubectl --token` checks from Task 11 Step 3.
- [ ] **Step 5: Seed** — `kubectl -n kubeport create job --from=cronjob/kubeport-demo-reset demo-seed-initial && kubectl -n kubeport logs job/demo-seed-initial -c seed -f` → `seed-demo: done`.
- [ ] **Step 6: Smoke in a browser** — `/` shows both demo buttons + password; "사용자로 체험" → Dex prefilled → `/catalog` shows 3 templates + banner; deploy `web-app` into `demo` → release detail shows pods; `nightly-job-demo` shows the failure explainer; as demo-admin `/admin/teams` "새 팀" returns the demo-restricted message. Google login still works.
- [ ] **Step 7: Verify reset** — wait for the next 6h tick or `kubectl -n kubeport create job --from=cronjob/kubeport-demo-reset demo-reset-manual`; confirm the extra release you created is gone and the seeds are back.
- [ ] **Step 8: Runbook** — record the Dex client secret location, `DEMO_PW` rotation procedure (rotate = re-run Step 2–3 with new hash/hint/passwords), and the ephemeral-IP DNS caveat for the dex host.

---

### Task 13: CLAUDE.md + spec/plan bookkeeping

**Files:**
- Modify: `CLAUDE.md` (현재 상태 블록, plan table), `docs/superpowers/specs/2026-09-07-self-improving-loop-design.md` §9

- [ ] **Step 1:** In `CLAUDE.md` plan table add row `13 | plan13-demo-mode | 🚧 in progress → ✅ | Dex 데모 IdP + 데모 계정 2개 + 시드/리셋 + k3s 구조화 인증`. In 현재 상태 remove "(c) 데모용 첫 템플릿 시드" and add "데모 모드 라이브: `/` 에서 관리자/사용자 체험, 6시간 리셋". Note: the `kuberport` → `kubeport` rename that used to be listed here as a follow-up was **rejected** — see the `kuberport` 표기 row in CLAUDE.md "확정된 결정" (it is the real SSH key and directory name; renaming it breaks the documented path to production).
- [ ] **Step 2:** In the spec §9 mark "데모 비밀번호: 표기+입력 — 구현됨(`DEMO_PASSWORD_HINT`)". In spec §4.1 record two deviations: (a) no `demo` team — templates are global, because demo-admin is blocked from team management; (b) the banner's Sentry feedback button is deferred to Plan 14 (Sentry SDK lands there).
- [ ] **Step 3:** Commit: `git commit -am "docs: Plan 13 demo mode status in CLAUDE.md and spec"`.

---

## Verification before PR

- `cd backend && go vet ./... && go test ./...` (compose up) — all green.
- `cd frontend && pnpm lint && pnpm tsc --noEmit && pnpm vitest run` — all green.
- `make helm-lint && make helm-snapshot` — exit 0; `helm template` with defaults renders no dex/demo objects.
- `pnpm test:e2e` against the local stack (with demo seed) — all specs pass.
- Self-review checklist (CLAUDE.md): IDOR (demo guard covers cluster/team/force-delete; everything else is k8s RBAC), rollback (k3s script auto-rollback; seed 409 idempotency), input validation (`ParseIssuersJSON` rejects blanks/dupes), no per-request env reads, contexts threaded through seed HTTP calls.
- Run `superpowers:code-reviewer` (>3 files changed). PR title `feat(demo): Dex demo IdP, demo accounts with seed/reset, k3s structured auth`, body in Korean with 테스트 계획 checkboxes mirroring the list above.
