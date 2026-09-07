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
			// A partially-seeded template (created but never published, or its
			// draft deleted by a demo visitor) must still end up in the shape
			// the demo expects: v1 published + a v2 draft to edit.
			if err := s.repairVersions(ctx, f.Name, f.ResourcesYAML, f.UISpecYAML); err != nil {
				return err
			}
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

// repairVersions brings an already-existing template back to the seeded shape:
// v1 published, and at least one draft version to edit. Idempotent — a fully
// seeded template produces no writes.
func (s *Seeder) repairVersions(ctx context.Context, name, resourcesYAML, uiSpecYAML string) error {
	code, b, err := s.admin.do(ctx, http.MethodGet, "/v1/templates/"+name+"/versions", nil)
	if err != nil {
		return err
	}
	if code != http.StatusOK {
		return fmt.Errorf("list versions %s: %d %s", name, code, b)
	}
	var listed struct {
		Versions []struct {
			Version int    `json:"version"`
			Status  string `json:"status"`
		} `json:"versions"`
	}
	if err := json.Unmarshal(b, &listed); err != nil {
		return fmt.Errorf("list versions %s: %w", name, err)
	}

	var v1Draft, otherDraft bool
	for _, v := range listed.Versions {
		if v.Status != "draft" {
			continue
		}
		if v.Version == 1 {
			v1Draft = true
		} else {
			otherDraft = true
		}
	}
	// v1 must be published (it is what the catalog deploys).
	if v1Draft {
		if code, b, err := s.admin.do(ctx, http.MethodPost, "/v1/templates/"+name+"/versions/1/publish", nil); err != nil || code >= 300 {
			return fmt.Errorf("publish %s v1: %d %s %v", name, code, b, err)
		}
		log.Printf("template %s v1 published", name)
	}
	// Publishing v1 does not leave an editable draft, so only a draft at some
	// other version counts.
	if otherDraft {
		log.Printf("template %s already has a draft, skipping", name)
		return nil
	}
	if code, b, err := s.admin.do(ctx, http.MethodPost, "/v1/templates/"+name+"/versions", map[string]any{
		"authoring_mode": "yaml", "resources_yaml": resourcesYAML, "ui_spec_yaml": uiSpecYAML,
		"notes": "데모용 초안 — 자유롭게 수정해 보세요",
	}); err != nil || code >= 300 {
		return fmt.Errorf("draft %s: %d %s %v", name, code, b, err)
	}
	log.Printf("template %s draft created", name)
	return nil
}
