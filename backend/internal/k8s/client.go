package k8s

import (
	"errors"

	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

type Client struct {
	dyn dynamic.Interface
	cs  kubernetes.Interface
}

// NewWithToken creates a k8s dynamic client using a bearer token.
// caBundle is required; use NewInsecureWithToken for dev/kind clusters.
func NewWithToken(apiURL, caBundle, bearer string) (*Client, error) {
	if caBundle == "" {
		return nil, errors.New("caBundle is required; use NewInsecureWithToken for dev/kind clusters")
	}
	cfg := &rest.Config{
		Host:            apiURL,
		BearerToken:     bearer,
		TLSClientConfig: rest.TLSClientConfig{CAData: []byte(caBundle)},
	}
	return newClient(cfg)
}

// NewInsecureWithToken creates a k8s dynamic client with TLS verification
// disabled. Intended only for local dev/kind clusters.
func NewInsecureWithToken(apiURL, bearer string) (*Client, error) {
	cfg := &rest.Config{
		Host:            apiURL,
		BearerToken:     bearer,
		TLSClientConfig: rest.TLSClientConfig{Insecure: true},
	}
	return newClient(cfg)
}

func newClient(cfg *rest.Config) (*Client, error) {
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	return &Client{dyn: dyn, cs: cs}, nil
}
