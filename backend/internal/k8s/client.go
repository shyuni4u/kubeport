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

// client-go's defaults are 5 QPS with a burst of 10, sized for a controller
// that holds one client for its lifetime. These clients are built per request
// from the caller's token and thrown away, so a single screen that makes a
// dozen calls spends seconds queueing behind a limiter that was never meant
// for it. The real bound is the apiserver's own priority and fairness, plus
// kubeport's per-caller limiter in internal/api/ratelimit.go.
const (
	clientQPS   = 50
	clientBurst = 100
)

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
		QPS:             clientQPS,
		Burst:           clientBurst,
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
		QPS:             clientQPS,
		Burst:           clientBurst,
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
