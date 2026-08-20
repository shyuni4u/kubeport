//go:build e2e
// +build e2e

package e2e_test

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

const (
	apiBase  = "http://localhost:8080"
	dexToken = "https://localhost:5556/token"
)

// dex serves a self-signed cert; e2e trusts it unconditionally.
var dexClient = &http.Client{
	Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}},
	Timeout:   10 * time.Second,
}

// TestMain starts compose + the Go API once for the package so both the
// happy-path and Plan 2 tests share a server. The server's defer-kill from
// the individual tests wasn't viable: when the first test exits, the server
// dies before the next test runs.
//
// If KBP_KIND_API is unset, we don't start anything — the tests themselves
// skip, and TestMain short-circuits to m.Run() so `go test ./...` from the
// repo root doesn't spin up docker on casual runs.
func TestMain(m *testing.M) {
	if os.Getenv("KBP_KIND_API") == "" {
		os.Exit(m.Run())
	}

	if err := exec.Command("docker", "compose",
		"-f", "../../deploy/docker/docker-compose.yml", "up", "-d").Run(); err != nil {
		fmt.Fprintln(os.Stderr, "docker compose up failed:", err)
		os.Exit(1)
	}

	// e2e uses fixed resource names ("kind", "web-e2e", "plat", "ui-web-plat", …),
	// so leftover rows from prior integration/unit runs cause 409s. Truncate the
	// app tables before each e2e run. Only safe because TestMain is gated by
	// KBP_KIND_API being set — a deliberate opt-in.
	//
	// Use `docker compose exec <service>` (not `docker exec <container>`), so the
	// compose project name derivation doesn't matter — we only rely on the
	// service name staying "postgres".
	truncate := `TRUNCATE sessions, team_memberships, teams, releases, template_versions, templates, clusters, users CASCADE`
	if out, err := exec.Command("docker", "compose",
		"-f", "../../deploy/docker/docker-compose.yml",
		"exec", "-T", "postgres",
		"psql", "-U", "kubeport", "-d", "kubeport", "-c", truncate).CombinedOutput(); err != nil {
		fmt.Fprintln(os.Stderr, "db truncate failed:", err, string(out))
		os.Exit(1)
	}

	wd, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(os.Stderr, "getwd:", err)
		os.Exit(1)
	}
	dexCert := filepath.Join(wd, "..", "..", "deploy", "docker", "certs", "dex.crt")

	cmd := exec.Command("go", "run", "../cmd/server")
	cmd.Env = append(os.Environ(),
		"LISTEN_ADDR=:8080",
		"DATABASE_URL=postgres://kubeport:kubeport@localhost:5432/kubeport?sslmode=disable",
		"OIDC_ISSUER=https://host.docker.internal:5556",
		"OIDC_AUDIENCE=kubeport",
		"OIDC_CA_FILE="+dexCert,
		// 32 zero bytes base64 — test-only; DB is expected to be clean between runs.
		"APP_ENCRYPTION_KEY_B64=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
		"KBP_DEV_ADMIN_EMAILS=admin@example.com",
	)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "server start failed:", err)
		os.Exit(1)
	}
	cleanup := func() {
		if cmd.Process != nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
	}

	ready := false
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		r, err := http.Get(apiBase + "/healthz")
		if err == nil {
			r.Body.Close()
			if r.StatusCode == http.StatusOK {
				ready = true
				break
			}
		}
		time.Sleep(300 * time.Millisecond)
	}
	if !ready {
		cleanup()
		fmt.Fprintln(os.Stderr, "API did not become ready on :8080 within 60s")
		os.Exit(1)
	}

	code := m.Run()
	cleanup()
	os.Exit(code)
}

// fetchDexIDToken uses the dex password grant to get an id_token.
func fetchDexIDToken(t *testing.T, email, password string) string {
	t.Helper()
	form := url.Values{}
	form.Set("grant_type", "password")
	form.Set("client_id", "kubeport")
	form.Set("client_secret", "local-dev-secret")
	form.Set("username", email)
	form.Set("password", password)
	form.Set("scope", "openid email profile groups")
	resp, err := dexClient.Post(dexToken, "application/x-www-form-urlencoded", strings.NewReader(form.Encode()))
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var out struct {
		IDToken string `json:"id_token"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	require.NotEmpty(t, out.IDToken)
	return out.IDToken
}

func doAPI(t *testing.T, token, method, path string, body any) *http.Response {
	t.Helper()
	var buf io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		buf = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(context.Background(), method, apiBase+path, buf)
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	return resp
}

// call is the common pattern: make request, read body (always, so the failure
// message has detail), close, return status + body bytes. Using this instead
// of passing bodyOf(resp) as a require msg avoids a subtle bug where the
// variadic arg is evaluated eagerly and drains the body before the test's
// own JSON decode can read it.
func call(t *testing.T, token, method, path string, body any) (int, []byte) {
	t.Helper()
	resp := doAPI(t, token, method, path, body)
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	return resp.StatusCode, b
}

// ensureCluster registers the "kind" cluster via the admin token. Idempotent:
// 201 on first call within the run, 409 on later calls (another test already
// registered it). Keeps each test runnable in isolation (`-run TestE2E_Plan2`)
// without tying ordering to TestE2E_HappyPath.
func ensureCluster(t *testing.T, adminTok string) {
	t.Helper()
	status, body := call(t, adminTok, http.MethodPost, "/v1/clusters", map[string]any{
		"name":            "kind",
		"api_url":         os.Getenv("KBP_KIND_API"),
		"oidc_issuer_url": "https://host.docker.internal:5556",
	})
	if status != http.StatusCreated && status != http.StatusConflict {
		require.FailNow(t, "cluster register failed", "status=%d body=%s", status, body)
	}
}

// TestE2E_HappyPath exercises the full vertical slice:
//   register cluster (admin) → create + publish template (admin) →
//   deploy release (user) → list → get (poll until healthy) → delete
//
// Prerequisites:
//   - docker compose up (postgres + dex) — TestMain handles this
//   - Go API running on :8080 — TestMain handles this
//   - KBP_KIND_API set to the kind API server URL (otherwise the test is skipped)
//   - kubectl configured for the same kind cluster
func TestE2E_HappyPath(t *testing.T) {
	if os.Getenv("KBP_KIND_API") == "" {
		t.Skip("KBP_KIND_API not set; skipping e2e (requires kind cluster)")
	}

	adminTok := fetchDexIDToken(t, "admin@example.com", "admin")
	userTok := fetchDexIDToken(t, "alice@example.com", "alice")

	// 1. Register cluster (admin)
	ensureCluster(t, adminTok)

	// 2. Create template (admin) and publish v1
	status, body := call(t, adminTok, http.MethodPost, "/v1/templates", map[string]any{
		"name":           "web-e2e",
		"display_name":   "Web E2E",
		"authoring_mode": "yaml",
		"resources_yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata: {name: web}\nspec:\n  replicas: 1\n  selector: {matchLabels: {app: web}}\n  template:\n    metadata: {labels: {app: web}}\n    spec:\n      containers:\n        - name: app\n          image: nginx:1.25\n",
		"ui_spec_yaml":   "fields:\n  - path: Deployment[web].spec.replicas\n    label: replicas\n    type: integer\n    min: 1\n    max: 5\n",
	})
	require.Equal(t, http.StatusCreated, status, string(body))

	status, body = call(t, adminTok, http.MethodPost, "/v1/templates/web-e2e/versions/1/publish", nil)
	require.Equal(t, http.StatusOK, status, string(body))

	// 3. User deploys
	status, body = call(t, userTok, http.MethodPost, "/v1/releases", map[string]any{
		"template":  "web-e2e",
		"version":   1,
		"cluster":   "kind",
		"namespace": "default",
		"name":      "my-api",
		"values":    map[string]any{"Deployment[web].spec.replicas": 2},
	})
	require.Equal(t, http.StatusCreated, status, string(body))
	var rel struct {
		ID string `json:"id"`
	}
	require.NoError(t, json.Unmarshal(body, &rel))
	require.NotEmpty(t, rel.ID, "release id missing in response: "+string(body))

	// 4. Poll until healthy
	require.Eventually(t, func() bool {
		s, b := call(t, userTok, http.MethodGet, "/v1/releases/"+rel.ID, nil)
		return s == http.StatusOK && bytes.Contains(b, []byte(`"status":"healthy"`))
	}, 60*time.Second, 2*time.Second, "release never became healthy")

	// 5. User lists releases
	status, body = call(t, userTok, http.MethodGet, "/v1/releases", nil)
	require.Equal(t, http.StatusOK, status)
	require.Contains(t, string(body), "my-api")

	// 6. Delete release and confirm k8s resources are gone
	status, body = call(t, userTok, http.MethodDelete, "/v1/releases/"+rel.ID, nil)
	require.Equal(t, http.StatusOK, status, string(body))
	require.Contains(t, string(body), `"deleted":true`)

	// Using kubectl directly to confirm. kubectl must be configured for KBP_KIND_API.
	// kubectl prints "No resources found" to stderr on an empty match, so use
	// stdout-only to assert the deployment is gone.
	out, err := exec.Command("kubectl", "-n", "default", "get", "deployments",
		"-l", "kubeport.io/release=my-api", "--no-headers").Output()
	require.NoError(t, err)
	require.Empty(t, strings.TrimSpace(string(out)), "deployment should have been deleted")

	fmt.Println("e2e happy path passed")
}

// TestE2E_Plan2_TeamEditorFlow exercises:
//   admin registers cluster → creates team → adds alice as editor →
//   alice (via adminToken-like flow) creates a UI-mode template in the team →
//   publish → deploy as alice → deprecate v1 → new deploy rejected
func TestE2E_Plan2_TeamEditorFlow(t *testing.T) {
	if os.Getenv("KBP_KIND_API") == "" {
		t.Skip("KBP_KIND_API not set")
	}
	adminTok := fetchDexIDToken(t, "admin@example.com", "admin")
	aliceTok := fetchDexIDToken(t, "alice@example.com", "alice")

	// Register cluster up front so this test is runnable on its own
	// (`go test -run TestE2E_Plan2`) — accepts 409 if HappyPath already did it.
	ensureCluster(t, adminTok)

	// 1. Create team 'plat' and add alice as editor
	status, body := call(t, adminTok, http.MethodPost, "/v1/teams",
		map[string]any{"name": "plat", "display_name": "Platform"})
	require.Equal(t, http.StatusCreated, status, string(body))
	var team struct {
		ID string `json:"id"`
	}
	require.NoError(t, json.Unmarshal(body, &team))
	require.NotEmpty(t, team.ID, "team id missing: "+string(body))

	// alice must have logged in once to appear in users table; /v1/me is enough.
	status, body = call(t, aliceTok, http.MethodGet, "/v1/me", nil)
	require.Equal(t, http.StatusOK, status, string(body))

	status, body = call(t, adminTok, http.MethodPost, "/v1/teams/"+team.ID+"/members",
		map[string]any{"email": "alice@example.com", "role": "editor"})
	require.Equal(t, http.StatusCreated, status, string(body))

	// 2. alice creates a UI-mode template owned by team plat
	tplName := "ui-web-plat"
	status, body = call(t, aliceTok, http.MethodPost, "/v1/templates", map[string]any{
		"name":           tplName,
		"display_name":   "UI Web",
		"authoring_mode": "ui",
		"owning_team_id": team.ID,
		"ui_state": map[string]any{
			"resources": []any{
				map[string]any{
					"apiVersion": "apps/v1", "kind": "Deployment", "name": "web",
					"fields": map[string]any{
						"spec.replicas": map[string]any{
							"mode":   "exposed",
							"uiSpec": map[string]any{"label": "Replicas", "type": "integer", "default": 1, "required": true},
						},
						"spec.selector.matchLabels.app":          map[string]any{"mode": "fixed", "fixedValue": "web"},
						"spec.template.metadata.labels.app":      map[string]any{"mode": "fixed", "fixedValue": "web"},
						"spec.template.spec.containers[0].name":  map[string]any{"mode": "fixed", "fixedValue": "app"},
						"spec.template.spec.containers[0].image": map[string]any{"mode": "fixed", "fixedValue": "nginx:1.25"},
					},
				},
			},
		},
	})
	require.Equal(t, http.StatusCreated, status, string(body))

	// 3. publish v1 (alice is editor)
	status, body = call(t, aliceTok, http.MethodPost, "/v1/templates/"+tplName+"/versions/1/publish", nil)
	require.Equal(t, http.StatusOK, status, string(body))

	// 4. alice deploys it
	status, body = call(t, aliceTok, http.MethodPost, "/v1/releases", map[string]any{
		"template": tplName, "version": 1, "cluster": "kind", "namespace": "default",
		"name":   "ui-web-plat-rel",
		"values": map[string]any{"Deployment[web].spec.replicas": 1},
	})
	require.Equal(t, http.StatusCreated, status, string(body))
	var rel struct {
		ID string `json:"id"`
	}
	require.NoError(t, json.Unmarshal(body, &rel))
	require.NotEmpty(t, rel.ID, "release id missing: "+string(body))

	// 5. deprecate v1
	status, body = call(t, aliceTok, http.MethodPost, "/v1/templates/"+tplName+"/versions/1/deprecate", nil)
	require.Equal(t, http.StatusOK, status, string(body))

	// 6. new deploy attempt fails
	status, body = call(t, aliceTok, http.MethodPost, "/v1/releases", map[string]any{
		"template": tplName, "version": 1, "cluster": "kind", "namespace": "default",
		"name":   "ui-web-plat-rel-2",
		"values": map[string]any{"Deployment[web].spec.replicas": 1},
	})
	require.Equal(t, http.StatusBadRequest, status, string(body))
	require.Contains(t, string(body), "deprecated")

	// 7. cleanup: delete the running release
	status, body = call(t, aliceTok, http.MethodDelete, "/v1/releases/"+rel.ID, nil)
	require.Equal(t, http.StatusOK, status, string(body))
}
