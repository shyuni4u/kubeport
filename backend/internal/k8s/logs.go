package k8s

import (
	"bufio"
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes"
)

// LogLine is one emitted log entry from a single pod.
type LogLine struct {
	Pod  string `json:"pod"`
	Text string `json:"text"`
	// At is when the container wrote the line, as the kubelet recorded it.
	// Zero when the line arrived without a usable stamp — the caller decides
	// what to show then, since only it knows what it is rendering into.
	At time.Time `json:"-"`
}

// splitTimestamp separates the RFC3339Nano stamp that PodLogOptions.Timestamps
// puts in front of every line.
//
// Only the first space-delimited field is considered, and only if it parses:
// container output routinely begins with a date of its own — nginx writes
// `2026/09/09 07:36:36 [notice] ...` — and taking the head off such a line
// would be worse than having no time at all. A line with no usable stamp comes
// back whole, with a zero time.
func splitTimestamp(line string) (time.Time, string) {
	field, rest, _ := strings.Cut(line, " ")
	at, err := time.Parse(time.RFC3339Nano, field)
	if err != nil {
		return time.Time{}, line
	}
	return at, rest
}

// StreamLogs follows logs from the named pods in this client's cluster.
func (c *Client) StreamLogs(ctx context.Context, namespace string, pods []string) (<-chan LogLine, <-chan error) {
	return StreamPodLogs(ctx, c.cs, namespace, pods)
}

// StreamPodLogs follows logs from multiple pods concurrently and fans
// them into a single channel. ch closes when ctx is done or when all
// pods stop emitting. errCh closes after ch closes.
func StreamPodLogs(ctx context.Context, cs kubernetes.Interface, namespace string, pods []string) (<-chan LogLine, <-chan error) {
	ch := make(chan LogLine, 64)
	errCh := make(chan error, len(pods))

	var wg sync.WaitGroup
	for _, p := range pods {
		wg.Add(1)
		go func(pod string) {
			defer wg.Done()
			req := cs.CoreV1().Pods(namespace).GetLogs(pod, &corev1.PodLogOptions{
				Follow: true,
				// Ask the kubelet to prefix each line with when the container
				// wrote it. Without this the only clock available is the
				// server's own, read at the moment the line is forwarded, so
				// replayed history all landed on "now" — a pod that started 16
				// minutes ago showed its whole startup as having just happened,
				// and the log pane had no time axis at all (#131).
				Timestamps: true,
			})
			rc, err := req.Stream(ctx)
			if err != nil {
				errCh <- fmt.Errorf("pod %s: %w", pod, err)
				return
			}
			defer rc.Close()
			sc := bufio.NewScanner(rc)
			// 1MB line cap — k8s JSON logs + stack traces routinely exceed
			// the 64KB default and would surface as bufio.ErrTooLong.
			sc.Buffer(make([]byte, 64*1024), 1024*1024)
			for sc.Scan() {
				at, text := splitTimestamp(sc.Text())
				select {
				case <-ctx.Done():
					return
				case ch <- LogLine{Pod: pod, Text: text, At: at}:
				}
			}
			if err := sc.Err(); err != nil {
				errCh <- fmt.Errorf("pod %s scan: %w", pod, err)
			}
		}(p)
	}

	go func() {
		wg.Wait()
		close(ch)
		close(errCh)
	}()

	return ch, errCh
}
