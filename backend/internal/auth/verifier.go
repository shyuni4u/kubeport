package auth

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net/http"
	"os"

	"github.com/coreos/go-oidc/v3/oidc"
)

type Claims struct {
	Subject string   `json:"sub"`
	Email   string   `json:"email"`
	Name    string   `json:"name"`
	Groups  []string `json:"groups"`
}

type Verifier struct {
	v          *oidc.IDTokenVerifier
	httpClient *http.Client
}

func NewVerifier(ctx context.Context, issuer, clientID string) (*Verifier, error) {
	client, err := httpClientForIssuer()
	if err != nil {
		return nil, err
	}
	if client != nil {
		ctx = oidc.ClientContext(ctx, client)
	}
	provider, err := oidc.NewProvider(ctx, issuer)
	if err != nil {
		return nil, err
	}
	return &Verifier{v: provider.Verifier(&oidc.Config{ClientID: clientID}), httpClient: client}, nil
}

// httpClientForIssuer returns a client that trusts the CA file in OIDC_CA_FILE,
// or nil if unset (defaults to http.DefaultClient). Used for self-signed dex in dev.
func httpClientForIssuer() (*http.Client, error) {
	path := os.Getenv("OIDC_CA_FILE")
	if path == "" {
		return nil, nil
	}
	return httpClientFromCAFile(path)
}

// httpClientFromCAFile builds an *http.Client that trusts the PEM-encoded CA at
// path in addition to the system trust store. The transport is cloned from
// http.DefaultTransport so timeouts / HTTP/2 / connection pool tuning are
// inherited.
func httpClientFromCAFile(path string) (*http.Client, error) {
	pem, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read OIDC_CA_FILE: %w", err)
	}
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	if !pool.AppendCertsFromPEM(pem) {
		return nil, errors.New("OIDC_CA_FILE: no certs parsed")
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.TLSClientConfig = &tls.Config{RootCAs: pool}
	return &http.Client{Transport: tr}, nil
}

func (v *Verifier) Verify(ctx context.Context, rawToken string) (Claims, error) {
	if v.httpClient != nil {
		ctx = oidc.ClientContext(ctx, v.httpClient)
	}
	tok, err := v.v.Verify(ctx, rawToken)
	if err != nil {
		return Claims{}, err
	}
	var c Claims
	if err := tok.Claims(&c); err != nil {
		return Claims{}, err
	}
	return c, nil
}
