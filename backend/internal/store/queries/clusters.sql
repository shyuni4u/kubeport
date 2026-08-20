-- name: ListClusters :many
SELECT * FROM clusters ORDER BY name;

-- name: GetClusterByName :one
SELECT * FROM clusters WHERE name = $1;

-- name: InsertCluster :one
INSERT INTO clusters (name, display_name, api_url, ca_bundle, oidc_issuer_url, default_namespace)
VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;
