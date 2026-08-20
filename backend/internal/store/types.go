package store

import "github.com/jackc/pgx/v5/pgtype"

// PgText wraps a Go string as a pgtype.Text. Empty strings become SQL NULL.
func PgText(s string) pgtype.Text {
	if s == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: s, Valid: true}
}
