package api

import "time"

// SetReleaseCleanupK8sTimeout shortens how long a failed create waits on the
// cluster cleanup, so a test can reach the row delete after it gives up
// without waiting 30 seconds. It returns the function that restores it.
func SetReleaseCleanupK8sTimeout(d time.Duration) (restore func()) {
	prev := releaseCleanupK8sTimeout
	releaseCleanupK8sTimeout = d
	return func() { releaseCleanupK8sTimeout = prev }
}
