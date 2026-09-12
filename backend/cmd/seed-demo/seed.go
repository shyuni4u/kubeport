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
	"strconv"
	"strings"
	"time"
)

type releaseSpec struct {
	Name, Template string
	Values         json.RawMessage
}

// releaseSpecs: one healthy release, one that fails to pull (bad tag) so the
// failure explainer UX is visible to demo visitors (spec §4.1 seed data).
//
// The healthy one is deliberately not web-app. Visitors, and the reviewer
// persona scripts, are sent to deploy web-app into this same namespace, and
// web-app's object names are fixed by the template. A seeded web-app release
// holds Deployment/web, Service/web and ConfigMap/web-config, so since #161
// every visitor's web-app deploy would be refused for taking them over.
// Before #161 it was worse: the visitor's release silently took them, and
// deleting it deleted the seed's. nightly-job's seed release keeps
// CronJob/nightly the same way, which is acceptable because it exists to fail,
// and the 409 names it.
func releaseSpecs() []releaseSpec {
	return []releaseSpec{
		{Name: "app-with-config-demo", Template: "app-with-config", Values: json.RawMessage(`{"ConfigMap[app-config].data.REGION":"kr","Secret[app-secret].stringData.API_KEY":"demo-placeholder-not-a-secret"}`)},
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
	code, b, _, err := c.doWithHeader(ctx, method, path, body)
	return code, b, err
}

func (c *apiClient) doWithHeader(ctx context.Context, method, path string, body any) (int, []byte, http.Header, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, nil, nil, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, rd)
	if err != nil {
		return 0, nil, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		return 0, nil, nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b, resp.Header, nil
}

type Seeder struct {
	admin, user *apiClient
	cluster, ns string
	// versions is the version each fixture template's release deploys: its
	// current one, read after the templates are seeded (#306).
	versions map[string]int32
	// wait sleeps between rate-limited attempts; nil means a real timer.
	// Tests replace it so they do not sleep.
	wait func(context.Context, time.Duration) error
}

// seedWriteAttempts bounds how often one release create is retried after a
// 429. With Retry-After clamped to at most seedMaxRetryWait, the worst case
// stays well inside the reset Job's activeDeadlineSeconds.
const (
	seedWriteAttempts = 20
	seedMaxRetryWait  = 10 * time.Second
)

// createRelease posts one seed release and waits out a 429.
//
// The seeder runs as the demo user, the same identity every demo visitor
// signs in as, so it shares that identity's release write budget (#232). A
// visitor who happens to be deploying and deleting at 06:00 KST can have spent
// it, and by then the reset has already wiped the namespace and the rows: a
// 429 read as a hard failure left the demo empty until the next day. The
// budget refills a token every two seconds, so waiting is enough for a
// collision. A caller deliberately keeping the bucket empty still wins, which
// is #200's per-login key to fix, not this retry's.
func (s *Seeder) createRelease(ctx context.Context, body map[string]any) (int, []byte, error) {
	for attempt := 1; ; attempt++ {
		code, b, hdr, err := s.user.doWithHeader(ctx, http.MethodPost, "/v1/releases", body)
		if err != nil || code != http.StatusTooManyRequests || attempt >= seedWriteAttempts {
			return code, b, err
		}
		wait := retryAfter(hdr)
		log.Printf("release %v: rate-limited (attempt %d/%d), retrying in %s", body["name"], attempt, seedWriteAttempts, wait)
		if err := s.sleep(ctx, wait); err != nil {
			return 0, nil, err
		}
	}
}

func (s *Seeder) sleep(ctx context.Context, d time.Duration) error {
	if s.wait != nil {
		return s.wait(ctx, d)
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// retryAfter reads a 429's Retry-After seconds, clamped to [1s, seedMaxRetryWait].
func retryAfter(h http.Header) time.Duration {
	secs, err := strconv.Atoi(h.Get("Retry-After"))
	if err != nil || secs < 1 {
		secs = 2
	}
	d := time.Duration(secs) * time.Second
	if d > seedMaxRetryWait {
		d = seedMaxRetryWait
	}
	return d
}

// Run creates the demo releases. Templates are seeded separately and
// straight to the database (templates.go) because the demo accounts this
// runs as are barred from authoring into the shared catalog; releases stay
// here because creating one applies manifests to the demo cluster.
func (s *Seeder) Run(ctx context.Context) error {
	// 201, or a 409 saying the release is already there, are both fine.
	for _, r := range releaseSpecs() {
		// Not a fixed v1: a reset can keep only another version, and repair
		// deprecates a version that is not the fixture's content (#306).
		version, ok := s.versions[r.Template]
		if !ok {
			return fmt.Errorf("create release %s: no seeded version of template %s", r.Name, r.Template)
		}
		code, b, err := s.createRelease(ctx, map[string]any{
			"template": r.Template, "version": version, "cluster": s.cluster, "namespace": s.ns, "name": r.Name, "values": r.Values,
		})
		if err != nil {
			return err
		}
		switch code {
		case http.StatusCreated:
			log.Printf("release %s created", r.Name)
		case http.StatusConflict:
			// Only a name clash means "already seeded". resource-conflict means
			// something else holds the objects this release would create, a
			// visitor's release say, and the seed release was NOT created.
			// Skipping that as done would leave a demo that reports itself seeded
			// while missing a release, which is #117 over again.
			if problemTitle(b) == "resource-conflict" {
				return fmt.Errorf("create release %s: its objects belong to something else: %s", r.Name, b)
			}
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

// problemTitle returns the error kind of an RFC 7807 body, or "" when b is not
// one.
func problemTitle(b []byte) string {
	var p struct {
		Title string `json:"title"`
	}
	if json.Unmarshal(b, &p) != nil {
		return ""
	}
	return p.Title
}
