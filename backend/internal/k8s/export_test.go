package k8s

import "k8s.io/client-go/dynamic"

var (
	SplitYAML = splitYAML
	Pluralize = pluralize
)

// NewForTest builds a Client around an injected dynamic.Interface (e.g. a
// k8s.io/client-go/dynamic/fake client) for unit tests that don't need a
// real cluster.
func NewForTest(dyn dynamic.Interface) *Client {
	return &Client{dyn: dyn}
}
