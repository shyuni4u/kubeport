package auth

import "context"

type ctxKey struct{}

type RequestUser struct {
	Claims
	IDToken string
}

func WithUser(ctx context.Context, u RequestUser) context.Context {
	return context.WithValue(ctx, ctxKey{}, u)
}

func UserFrom(ctx context.Context) (RequestUser, bool) {
	u, ok := ctx.Value(ctxKey{}).(RequestUser)
	return u, ok
}
