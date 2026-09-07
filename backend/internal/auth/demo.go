package auth

import "strings"

// IsDemoEmail reports whether email belongs to the demo account domain.
// An empty domain disables demo handling entirely (returns false).
func IsDemoEmail(email, domain string) bool {
	if domain == "" || email == "" {
		return false
	}
	return strings.HasSuffix(strings.ToLower(email), "@"+strings.ToLower(domain))
}
