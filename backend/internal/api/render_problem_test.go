package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"kubeport/internal/template"
)

func renderProblemBody(t *testing.T, err error) Problem {
	t.Helper()
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/releases", nil)

	renderProblem(c, err)

	require.Equal(t, http.StatusBadRequest, w.Code)
	var p Problem
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &p))
	require.Equal(t, "validation-error", p.Title)
	return p
}

// #136: a stored version with an unknown field type cannot be deployed with any
// input. The 400 says which field, so the form does not ask the user to check
// what they typed.
func TestRenderProblem_MarksAnUnknownTypeAsATemplateDefect(t *testing.T) {
	err := fmt.Errorf("render: %w", &template.UnsupportedTypeError{
		Path: "Deployment[web].spec.replicas", Field: "replicas", Type: "int",
	})

	p := renderProblemBody(t, err)

	require.NotNil(t, p.TemplateDefect)
	require.Equal(t, ProblemTemplateDefect{Path: "Deployment[web].spec.replicas", Type: "int"}, *p.TemplateDefect)
	require.Contains(t, p.Detail, `unsupported field type "int"`)
}

func TestRenderProblem_LeavesAnInputErrorUnmarked(t *testing.T) {
	p := renderProblemBody(t, errors.New("replicas: above max 20"))

	require.Nil(t, p.TemplateDefect)
	require.Equal(t, "replicas: above max 20", p.Detail)
}
