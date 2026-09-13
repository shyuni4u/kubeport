package k8s

import (
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
)

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

// NewForTestWithClientset is NewForTest with a typed clientset too (e.g.
// k8s.io/client-go/kubernetes/fake), for code that asks access reviews.
func NewForTestWithClientset(dyn dynamic.Interface, cs kubernetes.Interface) *Client {
	return &Client{dyn: dyn, cs: cs}
}
