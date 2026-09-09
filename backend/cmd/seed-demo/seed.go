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

// Run creates the demo releases. Templates are seeded separately and
// straight to the database (templates.go) because the demo accounts this
// runs as are barred from authoring into the shared catalog; releases stay
// here because creating one applies manifests to the demo cluster.
func (s *Seeder) Run(ctx context.Context) error {
	// 201 or 409 (already seeded) are both fine.
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
			// Anything else is a real failure (bad values, cluster unreachable,
			// RBAC). Fail loudly so the reset Job goes CrashLoop/Failed instead
			// of leaving a half-seeded demo that looks healthy.
			// NOTE: the intentionally broken release still returns 201 — the
			// image only fails to pull later, inside the cluster.
			return fmt.Errorf("create release %s: %d %s", r.Name, code, b)
		}
	}
	return nil
}
