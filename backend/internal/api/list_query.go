package api

import (
	"net/http"
	"slices"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgtype"

	"kubeport/internal/store"
)

// onlyQuery refuses a request carrying a query parameter the endpoint does not
// read, and reports whether the request may go on (#74).
//
// Gin ignores what a handler does not read, so `GET /v1/releases?namespace=prod`
// answered 200 with every release: a person sees the list is wrong, a program
// concludes "prod holds only these" and acts on it. The refusal names what the
// endpoint takes rather than echoing what the caller sent.
func onlyQuery(c *gin.Context, allowed ...string) bool {
	for k := range c.Request.URL.Query() {
		if !slices.Contains(allowed, k) {
			writeError(c, http.StatusBadRequest, "validation-error",
				"unsupported query parameter; this endpoint takes: "+strings.Join(allowed, ", "))
			return false
		}
	}
	return true
}

// optionalText is a query filter for a sqlc.narg: empty means "no filter".
func optionalText(s string) pgtype.Text {
	return pgtype.Text{String: s, Valid: s != ""}
}

// filterTemplates keeps the rows matching the list's filters (#74):
//   - search: a case-insensitive substring of name or display_name
//   - tags:   every tag given must be on the template
//   - status: the current version's status (published, deprecated), or draft
//     for a template never published
//
// Applied to rows already authorized, so a filter can only narrow what the
// caller may see.
func filterTemplates(rows []store.ListTemplatesRow, search string, tags []string, status string) []store.ListTemplatesRow {
	search = strings.ToLower(search)
	out := rows[:0:0]
	for _, row := range rows {
		if search != "" &&
			!strings.Contains(strings.ToLower(row.Name), search) &&
			!strings.Contains(strings.ToLower(row.DisplayName), search) {
			continue
		}
		if !hasEveryTag(row.Tags, tags) {
			continue
		}
		if status != "" && templateStatus(row) != status {
			continue
		}
		out = append(out, row)
	}
	return out
}

func hasEveryTag(have, want []string) bool {
	for _, t := range want {
		if !slices.Contains(have, t) {
			return false
		}
	}
	return true
}

func templateStatus(row store.ListTemplatesRow) string {
	if !row.CurrentVersionID.Valid {
		return "draft"
	}
	return row.CurrentStatus.String
}
