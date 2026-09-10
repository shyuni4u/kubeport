# `url` and `dev` are variables so scripts/test-db.sh can apply this same env to
# a per-session test database (`--var url=... --var dev=...`). The defaults are
# the shared dev database and a throwaway docker postgres, so
# `atlas schema apply --env local` — CI, up.sh, docs — is unchanged.
variable "url" {
  type    = string
  default = "postgres://kubeport:kubeport@localhost:5432/kubeport?sslmode=disable"
}

variable "dev" {
  type    = string
  default = "docker://postgres/16/dev"
}

env "local" {
  src = "file://schema.hcl"
  url = var.url
  dev = var.dev
}
