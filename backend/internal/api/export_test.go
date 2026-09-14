package api

import (
	"time"

	"github.com/gin-gonic/gin/binding"
)

// SetReleaseCleanupK8sTimeout shortens how long a failed create waits on the
// cluster cleanup, so a test can reach the row delete after it gives up
// without waiting 30 seconds. It returns the function that restores it.
func SetReleaseCleanupK8sTimeout(d time.Duration) (restore func()) {
	prev := releaseCleanupK8sTimeout
	releaseCleanupK8sTimeout = d
	return func() { releaseCleanupK8sTimeout = prev }
}

// ValidateCreateTemplateName runs the create request's own binding on a name,
// with the rest of the request filled in validly, so a test can hold
// openapi.yaml's TemplateName pattern to it (#369).
func ValidateCreateTemplateName(name string) error {
	return binding.Validator.ValidateStruct(&createTemplateReq{Name: name, DisplayName: "x", AuthoringMode: "yaml"})
}
