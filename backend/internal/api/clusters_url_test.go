package api

import "testing"

// #195: one apiserver registered under two names is refused, so spellings of
// the same URL must compare equal — and different apiservers must not.
func TestNormalizeAPIURL(t *testing.T) {
	same := [][]string{
		{"https://kube.example.com:6443", "https://KUBE.example.com:6443/", "  https://kube.example.com:6443  "},
		{"https://kube.example.com", "https://kube.example.com:443", "HTTPS://kube.example.com/"},
		{"http://10.0.0.1", "http://10.0.0.1:80"},
		{"https://[::1]:6443", "https://[::1]:6443/"},
		{"https://kube.example.com/k8s/clusters/c-1", "https://kube.example.com/k8s/clusters/c-1/"},
	}
	for _, group := range same {
		want := normalizeAPIURL(group[0])
		for _, s := range group[1:] {
			if got := normalizeAPIURL(s); got != want {
				t.Errorf("normalizeAPIURL(%q) = %q, want %q (same as %q)", s, got, want, group[0])
			}
		}
	}

	different := [][2]string{
		{"https://kube.example.com:6443", "https://kube.example.com:6444"},
		{"https://kube.example.com", "http://kube.example.com"},
		{"https://kube-a.example.com", "https://kube-b.example.com"},
		{"https://kube.example.com/k8s/clusters/c-1", "https://kube.example.com/k8s/clusters/c-2"},
	}
	for _, pair := range different {
		if normalizeAPIURL(pair[0]) == normalizeAPIURL(pair[1]) {
			t.Errorf("normalizeAPIURL treats %q and %q as the same apiserver", pair[0], pair[1])
		}
	}
}
