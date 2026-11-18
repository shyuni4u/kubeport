package api

import (
	"context"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/require"
	"kubeport/internal/store"
)

type lookupFailureDB struct{ err error }

func (db lookupFailureDB) Exec(context.Context, string, ...interface{}) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, db.err
}
func (db lookupFailureDB) Query(context.Context, string, ...interface{}) (pgx.Rows, error) {
	return nil, db.err
}
func (db lookupFailureDB) QueryRow(context.Context, string, ...interface{}) pgx.Row {
	return lookupFailureRow{db.err}
}

type lookupFailureRow struct{ err error }

func (r lookupFailureRow) Scan(...interface{}) error { return r.err }

// Inject failures at the SQL boundary without a database outage or bypassing
// the real generated store methods. Missing rows stay 404; all other failures
// must be retryable 500s whose bodies never disclose the database error.
func TestLookupErrors(t *testing.T) {
	for _, failure := range []struct {
		name   string
		err    error
		status int
	}{
		{"missing", pgx.ErrNoRows, 404},
		{"wrapped missing", fmt.Errorf("lookup: %w", pgx.ErrNoRows), 404},
		{"database", errors.New("private database failure"), 500},
		{"cancelled", context.Canceled, 500},
		{"timeout", context.DeadlineExceeded, 500},
	} {
		t.Run(failure.name, func(t *testing.T) {
			h := &Handlers{deps: Deps{Store: &store.Store{Queries: store.New(lookupFailureDB{failure.err})}}}
			for name, handler := range map[string]gin.HandlerFunc{
				"template":       h.GetTemplate,
				"release":        h.GetRelease,
				"logs":           h.StreamReleaseLogs,
				"openapi":        func(c *gin.Context) { h.proxyOpenAPI(c, "v1") },
				"editor":         func(c *gin.Context) { h.ensureTemplateEditor(c, "test") },
				"draft":          func(c *gin.Context) { h.templateDraftAccess(c, "test") },
				"render-version": func(c *gin.Context) { h.resolveTemplateVersion(c, "test", "1") },
			} {
				t.Run(name, func(t *testing.T) {
					w := httptest.NewRecorder()
					c, _ := gin.CreateTestContext(w)
					c.Request = httptest.NewRequest("GET", "/", nil)
					c.Params = gin.Params{{Key: "name", Value: "test"}, {Key: "id", Value: "6f1c2a4e-9b3d-4c8a-a1e2-3f4b5c6d7e8f"}}
					handler(c)
					require.Equal(t, failure.status, w.Code, w.Body.String())
					if failure.status == 500 {
						require.Contains(t, w.Body.String(), `"title":"internal"`)
						require.NotContains(t, w.Body.String(), failure.err.Error())
					}
				})
			}
		})
	}
}

// Catch the original error-classification pattern across the package, including
// numeric 404s. Authorization-based hiding and explicit ErrNoRows/FK checks are
// deliberately outside this rule.
func TestNoUnconditionalNotFoundOnError(t *testing.T) {
	paths, err := filepath.Glob("*.go")
	require.NoError(t, err)
	fset := token.NewFileSet()
	for _, path := range paths {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		source, err := os.ReadFile(path)
		require.NoError(t, err)
		file, err := parser.ParseFile(fset, path, source, 0)
		require.NoError(t, err)
		ast.Inspect(file, func(node ast.Node) bool {
			stmt, ok := node.(*ast.IfStmt)
			if !ok {
				return true
			}
			cond, ok := stmt.Cond.(*ast.BinaryExpr)
			if !ok || cond.Op != token.NEQ {
				return true
			}
			lhs, lok := cond.X.(*ast.Ident)
			rhs, rok := cond.Y.(*ast.Ident)
			if !lok || !rok || lhs.Name != "err" || rhs.Name != "nil" {
				return true
			}
			for _, child := range stmt.Body.List {
				expr, ok := child.(*ast.ExprStmt)
				if !ok {
					continue
				}
				call, ok := expr.X.(*ast.CallExpr)
				if !ok || len(call.Args) < 2 {
					continue
				}
				fn, ok := call.Fun.(*ast.Ident)
				if !ok || fn.Name != "writeError" {
					continue
				}
				switch status := call.Args[1].(type) {
				case *ast.SelectorExpr:
					if status.Sel.Name == "StatusNotFound" {
						t.Errorf("%s: classify ErrNoRows before returning 404", fset.Position(call.Pos()))
					}
				case *ast.BasicLit:
					if status.Value == "404" {
						t.Errorf("%s: classify ErrNoRows before returning 404", fset.Position(call.Pos()))
					}
				}
			}
			return true
		})
	}
}
