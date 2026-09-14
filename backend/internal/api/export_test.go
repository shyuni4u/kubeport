package api

import (
	"errors"
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

// ValidateCreateTemplateName runs everything CreateTemplate holds a name to —
// the request's own binding, with the rest of it filled in validly, and then
// templateNameProblem — so a test can hold openapi.yaml's TemplateName rule to
// the server (#369).
func ValidateCreateTemplateName(name string) error {
	if err := binding.Validator.ValidateStruct(&createTemplateReq{Name: name, DisplayName: "x", AuthoringMode: "yaml"}); err != nil {
		return err
	}
	if problem := templateNameProblem(name); problem != "" {
		return errors.New(problem)
	}
	return nil
}
