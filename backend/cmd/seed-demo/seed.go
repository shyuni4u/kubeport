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
