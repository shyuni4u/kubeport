package k8s

import (
	"context"
	"testing"
	"time"

	fakecore "k8s.io/client-go/kubernetes/fake"
)

// TestStreamPodLogs_ClosesOnCancel verifies that the fan-in channel is
// closed when ctx is cancelled — the only behavior fake clientset can
// reliably exercise (it returns a fixed body, no real streaming).
func TestStreamPodLogs_ClosesOnCancel(t *testing.T) {
	cs := fakecore.NewSimpleClientset()
	ctx, cancel := context.WithCancel(context.Background())

	ch, errCh := StreamPodLogs(ctx, cs, "default", []string{"p1"})
	cancel()

	deadline := time.After(time.Second)
	for {
		select {
		case _, ok := <-ch:
			if !ok {
				ch = nil
			}
		case _, ok := <-errCh:
			if !ok {
				errCh = nil
			}
		case <-deadline:
			t.Fatalf("channels did not close after cancel")
		}
		if ch == nil && errCh == nil {
			return
		}
	}
}
