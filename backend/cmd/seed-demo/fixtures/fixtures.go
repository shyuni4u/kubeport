package fixtures

import _ "embed"

//go:embed web-app.resources.yaml
var webAppResources string

//go:embed web-app.ui-spec.yaml
var webAppUISpec string

//go:embed nightly-job.resources.yaml
var nightlyResources string

//go:embed nightly-job.ui-spec.yaml
var nightlyUISpec string

//go:embed app-with-config.resources.yaml
var appCfgResources string

//go:embed app-with-config.ui-spec.yaml
var appCfgUISpec string

type Template struct {
	Name, DisplayName, Description string
	Tags                           []string
	ResourcesYAML, UISpecYAML      string
}

func All() []Template {
	return []Template{
		{Name: "web-app", DisplayName: "웹 앱", Description: "nginx 기반 웹 서버 (Deployment + Service)", Tags: []string{"web", "demo"}, ResourcesYAML: webAppResources, UISpecYAML: webAppUISpec},
		{Name: "nightly-job", DisplayName: "야간 배치", Description: "주기적으로 실행되는 CronJob", Tags: []string{"batch", "demo"}, ResourcesYAML: nightlyResources, UISpecYAML: nightlyUISpec},
		{Name: "app-with-config", DisplayName: "설정 있는 앱", Description: "ConfigMap + Secret 을 주입받는 앱", Tags: []string{"web", "config", "demo"}, ResourcesYAML: appCfgResources, UISpecYAML: appCfgUISpec},
	}
}
