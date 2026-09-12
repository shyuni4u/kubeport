package store

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	*Queries
	pool *pgxpool.Pool
	// lockPool holds the connections apply locks live on (see LockApply), apart
	// from pool so that holding locks never takes a connection a query needs.
	lockPool *pgxpool.Pool
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
	lockCfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		pool.Close()
		return nil, err
	}
	lockCfg.MaxConns = applyLockConns
	lockCfg.MinConns = 0
	lockPool, err := pgxpool.NewWithConfig(ctx, lockCfg)
	if err != nil {
		pool.Close()
		return nil, err
	}
	return &Store{Queries: New(pool), pool: pool, lockPool: lockPool}, nil
}

func (s *Store) Close() {
	s.lockPool.Close()
	s.pool.Close()
}

// clusterRegistrationLock is the transaction-scoped advisory lock key that
// serialises cluster registration ("kbp_clus"). A constant of its own so no
// other lock in the database can collide with it.
const clusterRegistrationLock int64 = 0x6b62705f636c7573

// LockClusterRegistration takes the cluster registration lock for the rest of
// the transaction q is bound to. Registration refuses an api_url that another
// cluster already has (#195); the lock makes that check and the insert one
// step, so two concurrent registrations of one apiserver cannot both pass the
// check. Hand-written rather than generated: it is not a query on a table.
// Call it only on Queries from WithTx; outside a transaction the lock is
// released as soon as the statement ends.
func (q *Queries) LockClusterRegistration(ctx context.Context) error {
	_, err := q.db.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", clusterRegistrationLock)
	return err
}

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
