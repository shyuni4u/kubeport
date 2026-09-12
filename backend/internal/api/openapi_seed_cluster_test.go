package api_test

import (
	"fmt"
	"net/http"
	"testing"

	"kubeport/internal/api"
	"kubeport/internal/config"
)

// #304: seedClusterAt registers an httptest apiserver by its URL, and since
// #245 a second registration of the same api_url is a 409. The OS hands ports
// out again, so a row an earlier test left behind made an unrelated test fail
// now and then. Each seeded cluster is removed when its test ends; here two
// tests in a row register the very same URL.
func TestSeedClusterAt_FreesItsAPIURLWhenTheTestEnds(t *testing.T) {
	upstream, ca := fakeAPIServer(t, http.StatusOK, `{}`)
	r := api.NewRouter(config.Config{OpenAPICacheMax: 8},
		api.Deps{Verifier: adminVerifier{}, Store: testStore(t)})

	for i := range 2 {
		t.Run(fmt.Sprintf("seed %d", i), func(t *testing.T) {
			seedClusterAt(t, r, upstream, ca)
		})
	}
}
