package api_test

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/config"
	"kubeport/internal/k8s"
)

// Issue #191. The ownership check (#161) and the apply are separate calls, so
// two deploys into one namespace could both find an object free and both
// apply it, the second taking the first's over. The check and apply of one
// request must not interleave with another's in the same namespace.

// overlapProbe is a cluster that counts requests between their ownership
// check and the end of their apply, and remembers the most at once.
type overlapProbe struct {
	*fakeK8sApplier
	mu      sync.Mutex
	inside  int
	maxSeen int
}

func (p *overlapProbe) CheckApply(context.Context, k8s.ReleaseRef, []byte, bool) (k8s.ApplyCheck, error) {
	p.mu.Lock()
	p.inside++
	if p.inside > p.maxSeen {
		p.maxSeen = p.inside
	}
	p.mu.Unlock()
	// Long enough that without the lock the other request reaches its check.
	time.Sleep(150 * time.Millisecond)
	return k8s.ApplyCheck{}, nil
}

func (p *overlapProbe) ApplyAll(context.Context, string, []byte) error {
	p.mu.Lock()
	p.inside--
	p.mu.Unlock()
	return nil
}

type probeFactory struct{ probe *overlapProbe }

func (f probeFactory) NewWithToken(_, _, _ string) (api.K8sApplier, error) { return f.probe, nil }

func TestCreateRelease_ConcurrentDeploysIntoOneNamespaceDoNotInterleave(t *testing.T) {
	s := testStore(t)
	probe := &overlapProbe{fakeK8sApplier: &fakeK8sApplier{}}
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s, K8sFactory: probeFactory{probe}})
	clusterName := seedCluster(t, r)
	tpl := seedPublishedTemplate(t, r)

	// Two names that cannot clash: randSuffix is a clock reading, and two
	// goroutines can read the same one.
	suffix := randSuffix()
	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i, name := range []string{"race-a-" + suffix, "race-b-" + suffix} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := do(t, r, http.MethodPost, "/v1/releases", deployBody(t, tpl, clusterName, name))
			codes[i] = w.Code
		}()
	}
	wg.Wait()

	require.Equal(t, []int{http.StatusCreated, http.StatusCreated}, codes)
	require.Equal(t, 1, probe.maxSeen, "two deploys into one namespace were between check and apply at once")
}
