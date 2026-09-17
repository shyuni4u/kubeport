package k8s_test

import (
	"context"
	"fmt"
	"github.com/stretchr/testify/require"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
	"kubeport/internal/k8s"
	"os"
	"testing"
	"time"
)

func TestDryRunCreateWithKind(t *testing.T) {
	apiURL, ca := os.Getenv("KIND_API"), os.Getenv("KIND_CA")
	if apiURL == "" || ca == "" {
		if os.Getenv("KBP_REQUIRE_KIND") != "" {
			t.Fatal("KIND_API and KIND_CA required")
		}
		t.Skip("kind cluster not configured")
	}
	token := os.Getenv("DEX_TOKEN")
	client, err := k8s.NewWithToken(apiURL, ca, token)
	require.NoError(t, err)
	reader, err := dynamic.NewForConfig(&rest.Config{Host: apiURL, BearerToken: token, TLSClientConfig: rest.TLSClientConfig{CAData: []byte(ca)}})
	require.NoError(t, err)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	name := "dryrun-" + time.Now().Format("150405.000000")
	manifest := []byte(fmt.Sprintf("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: %s\ndata:\n  hello: world\n", name))
	require.NoError(t, client.DryRunCreate(ctx, "default", manifest))
	_, err = reader.Resource(schema.GroupVersionResource{Version: "v1", Resource: "configmaps"}).Namespace("default").Get(ctx, name, metav1.GetOptions{})
	require.True(t, apierrors.IsNotFound(err), "dry-run must not leave an object: %v", err)
	// The CI caller intentionally has ConfigMap rights only. Dry-run must
	// preserve that boundary instead of elevating to a cluster administrator.
	err = client.DryRunCreate(ctx, "default", []byte("apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: invalid-dryrun\n"))
	require.True(t, apierrors.IsForbidden(err), "dry-run must respect caller RBAC: %v", err)
	// ConfigMap data and binaryData cannot share a key: valid YAML, invalid object.
	err = client.DryRunCreate(ctx, "default", append(manifest, []byte("binaryData:\n  hello: d29ybGQ=\n")...))
	require.True(t, apierrors.IsInvalid(err), "apiserver must reject overlapping keys: %v", err)
	err = client.DryRunCreate(ctx, "default", append(manifest, []byte("unknownField: true\n")...))
	require.True(t, apierrors.IsBadRequest(err), "strict field validation must reject unknown fields: %v", err)
}
