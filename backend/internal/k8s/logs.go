package k8s

import (
	"bufio"
	"context"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes"
)

// LogLine is one emitted log entry from a single pod.
type LogLine struct {
	Pod  string `json:"pod"`
	Text string `json:"text"`
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
				select {
				case <-ctx.Done():
					return
				case ch <- LogLine{Pod: pod, Text: sc.Text()}:
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
