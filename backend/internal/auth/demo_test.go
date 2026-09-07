package auth_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/auth"
)

func TestIsDemoEmail(t *testing.T) {
	require.True(t, auth.IsDemoEmail("demo-user@demo.kubeport", "demo.kubeport"))
	require.True(t, auth.IsDemoEmail("Demo-Admin@DEMO.kubeport", "demo.kubeport"))
	require.False(t, auth.IsDemoEmail("alice@example.com", "demo.kubeport"))
	require.False(t, auth.IsDemoEmail("x@notdemo.kubeport", "demo.kubeport"))
	require.False(t, auth.IsDemoEmail("demo-user@demo.kubeport", ""), "empty domain disables the check")
	require.False(t, auth.IsDemoEmail("", "demo.kubeport"))
}
