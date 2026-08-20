package config

type Config struct {
	ListenAddr          string
	DatabaseURL         string
	OIDCIssuer          string
	OIDCAudience        string
	AppEncryptionKeyB64 string
	OpenAPICacheMax     int
}
