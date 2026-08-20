package store

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	*Queries
	pool *pgxpool.Pool
}

func NewStore(ctx context.Context, dsn string) (*Store, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return &Store{Queries: New(pool), pool: pool}, nil
}

func (s *Store) Close() { s.pool.Close() }

// WithTx runs fn inside a database transaction. The closure receives a
// *Queries bound to the tx; use it for all DB calls inside fn. Commits
// if fn returns nil, rolls back (and returns the fn error) otherwise.
// A post-commit Rollback is a no-op so the deferred cleanup is safe.
func (s *Store) WithTx(ctx context.Context, fn func(*Queries) error) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(s.Queries.WithTx(tx)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
