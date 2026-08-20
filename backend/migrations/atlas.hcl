env "local" {
  src = "file://schema.hcl"
  url = "postgres://kubeport:kubeport@localhost:5432/kubeport?sslmode=disable"
  dev = "docker://postgres/16/dev"
}
