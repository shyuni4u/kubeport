# Plan 13 (데모 모드) — 사람이 직접 해야 할 일

> 작성: 2026-09-07. 브랜치 `worktree-plan13-demo-mode` 구현·리뷰 완료 시점의 인계 문서.
> **2026-09-08 갱신: A(PR #2 머지)·B(프로덕션 롤아웃) 완료.** 남은 사람 작업은 B9 브라우저 스모크 하나.
> 완료한 항목은 체크하고, 다 끝나면 이 문서를 삭제하거나 runbook §5 에 흡수한다.

## A. 브랜치 통합 (지금)

- [x] 통합 방식 결정: 로컬 merge / PR / 보류. 권장은 **PR** (변경 89 파일, 23 커밋 — 리뷰 흔적을 남길 가치가 있음).
- [x] 로컬 `main` 에는 아직 origin 에 없는 문서 커밋 3개(리서치·스펙·플랜)가 있다. 브랜치를 푸시하면 함께 올라간다. 먼저 `main` 을 푸시하려면 `git push origin main` (main 에서).
- [x] PR 본문은 한국어, 제목은 `feat(demo): Dex demo IdP, demo accounts with seed/reset, k3s structured auth`. 본문에 명시할 것:
  - `DeleteRelease` 의 검사 순서가 바뀌어 비소유자 강제삭제의 에러 문구가 `"force delete requires admin"` 으로 변경됨(동작 동일).
  - 프론트 lint 에러 3건이 새로 추가됨(기존 5건과 동일 패턴: `DemoBanner` set-state-in-effect, `04-demo-user.spec.ts` 의 Playwright `use` 오탐). lint 는 CI 게이트가 아님. → §D 후속.
- [ ] PR 생성 후 `/gemini review` 를 **최종 코드에서 1회** 수동 실행 (CLAUDE.md 규칙) — 미실행, 머지 후 생략.
- [x] CI 확인 (`03-deprecate-flow` 는 main 과 동일한 기존 실패): `playwright.yml` 은 이번 브랜치에서 데모 시드·RBAC 스텝이 추가되어 처음 돌아간다. 실패하면 `Seed demo data` 스텝 로그부터 본다.

## B. 프로덕션 롤아웃 (Task 12) — VM 에서, 순서 중요

전체 절차와 명령은 [deploy/oci/README.md §7.6](../deploy/oci/README.md) 과
[플랜 Task 12](superpowers/plans/2026-09-07-plan13-demo-mode.md) 에 있다. 요약 체크리스트:

- [x] **B1. 이미지**: 브랜치가 main 에 머지되어 `build-images.yml` 이 새 태그를 푸시했는지 확인 (`seed-demo` 바이너리가 backend 이미지에 포함된 첫 빌드).
- [x] **B2. DNS**: GoDaddy(`enzo.kr`, 네임서버 `domaincontrol.com`) A 레코드 `dex.kubeport.enzo.kr` → 현재 공인 IP. 공인 IP 는 ephemeral 이라 stop/start 시 두 레코드(`kubeport.`, `dex.`) 모두 갱신해야 한다.
- [x] **B3. 시크릿 생성 후 비밀번호 관리자에 저장**:
  ```bash
  DEMO_PW=$(openssl rand -base64 9 | tr -d '/+=' | cut -c1-10)   # 사람이 칠 수 있게 짧게, 공개됨
  DEX_SECRET=$(openssl rand -hex 24)
  HASH=$(htpasswd -bnBC 10 "" "$DEMO_PW" | tr -d ':\n')
  ```
- [x] **B4. helm upgrade (최초 1회 전체 `--set`)**: `values-oci-phase2.yaml` 은 의도적으로 `dex.enabled=false` / `demo.enabled=false` 다. 처음 켤 때만 아래를 전부 주고, 이후에는 `--reuse-values` 가 유지한다.
  ```bash
  helm upgrade kubeport ~/kubeport-chart/kubeport -n kubeport --reuse-values \
    -f ~/kubeport-chart/kubeport/values-oci-phase2.yaml \
    --set images.backend.tag=$NEW_SHA --set images.frontend.tag=$NEW_SHA \
    --set dex.enabled=true --set dex.host=dex.kubeport.enzo.kr --set dex.clientSecret=$DEX_SECRET \
    --set "dex.staticPasswords[0].hash=$HASH" --set "dex.staticPasswords[1].hash=$HASH" \
    --set demo.enabled=true --set demo.passwordHint=$DEMO_PW \
    --set demo.adminPassword=$DEMO_PW --set demo.userPassword=$DEMO_PW
  ```
  주의: 이후 `--reuse-values` 없이 `-f values-oci-phase2.yaml` 만 쓰면 데모 모드가 **꺼진다**.
- [x] **B5. Dex 준비 확인**: `kubectl -n kubeport get certificate` 에서 Dex cert `Ready`, 그리고 **클러스터 내부에서** discovery 가 닿는지:
  ```bash
  kubectl -n kubeport exec deploy/kubeport-backend -- \
    wget -qO- https://dex.kubeport.enzo.kr/.well-known/openid-configuration | head -c 200
  ```
  backend 는 issuer discovery 를 지연 수행하므로 Dex 가 늦어도 죽지 않지만, 닿기 전까지 데모 로그인은 401 이다.
- [x] **B6. k3s 구조화 인증 전환** (Google + Dex): `sudo GOOGLE_CLIENT_ID=<id> bash deploy/oci/k3s-auth-config.sh`. 실패 시 자동 롤백, 수동 롤백은 `sudo ROLLBACK=1 bash deploy/oci/k3s-auth-config.sh`. 컨트롤플레인 약 30초 블립.
- [x] **B7. RBAC 검증** (README §7.6 검증 블록): `kubectl --token=$TOKEN auth whoami` → `dex:demo-user@demo.kubeport`; `-n demo can-i create deployments` → yes; `-n default` → no; `kubectl auth can-i delete resourcequota --as=dex:demo-admin@demo.kubeport -n demo` → **no**.
- [x] **B8. 최초 시드**: `kubectl -n kubeport create job --from=cronjob/kubeport-demo-reset demo-seed-initial` 후 `kubectl -n kubeport logs job/demo-seed-initial -c seed -f` 에서 `seed-demo: done`.
- [ ] **B9. 브라우저 스모크** (사람이 직접): `/` 에 체험 버튼 2개 + 비밀번호 표기 → "사용자로 체험" → Dex 폼에 이메일 프리필 → `/catalog` 에 템플릿 3개 + 데모 배너 → `web-app` 을 `demo` 로 배포 → 릴리스 상세에 파드 표시 → `nightly-job-demo` 는 실패 설명 배너 → demo-admin 으로 `/admin/teams` "새 팀" 이 데모 제한 문구 → **Google 로그인은 그대로 동작**.
- [x] **B10. 리셋 확인**: 6시간 틱을 기다리거나 `kubectl -n kubeport create job --from=cronjob/kubeport-demo-reset demo-reset-manual`. 내가 만든 릴리스가 사라지고 시드가 복구되는지.
- [x] **B11. runbook 갱신** — 문서 갱신 완료. 바인딩 이름 변경도 2026-09-08 완료(`kubeport-owner-admin` 생성 → 오너 권한 확인 → `kubeport-demo-admin` 삭제). 참고용 명령:
  ```bash
  kubectl get clusterrolebinding kubeport-demo-admin -o json | jq 'del(.metadata.uid,.metadata.resourceVersion,.metadata.creationTimestamp,.metadata.managedFields) | .metadata.name="kubeport-owner-admin"' | kubectl apply -f -
  kubectl auth can-i '*' '*' --as=<owner email>   # yes
  kubectl delete clusterrolebinding kubeport-demo-admin
  ```
  원래 항목: Dex client secret 보관 위치, `DEMO_PW` 회전 절차(B3→B4 재실행), Dex 호스트의 ephemeral IP 주의를 `docs/oci-prod-runbook.md` §5 에 기록. 기존 `kubeport-demo-admin` cluster-admin 바인딩이 남아 있으면 오너 이메일용 `kubeport-owner-admin` 만 남기고 제거.

## C. 로컬 개발 환경 정리 (이 머신, 선택)

이번 세션에서 Windows 쪽에 설치·생성한 것들. 두어도 무해하지만 알고 있어야 한다.

- 설치: Go 1.27, Helm 4(winget) + **Helm 3.20.2**(`%LOCALAPPDATA%\Programs\helm3\windows-amd64\helm.exe`, CI 핀과 같은 버전 — 스냅샷 재생성은 반드시 이걸로), pnpm 10, sqlc 1.31(`%USERPROFILE%\go\bin`), atlas 1.3(`%LOCALAPPDATA%\Programs\atlas`), kind 0.33.
- 실행 중: docker compose(postgres+dex), kind 클러스터 `kubeport`(dex OIDC 신뢰, 데모 RBAC, DB 에 `kind` 로 등록). 끄려면 `kind delete cluster --name kubeport`, `docker compose -f deploy/docker/docker-compose.yml down`.
- 로컬 postgres 볼륨에 예전 `kuberport` 역할 옆에 `kubeport` 역할/DB 를 추가했다. 볼륨을 새로 만들면 없어진다.
- `frontend/.env.local`(gitignored)에 데모 프로바이더 설정과 로컬용 `APP_ENCRYPTION_KEY_B64` 가 있다. backend 는 같은 키로 띄워야 세션이 복호화된다(값은 `docs/local-e2e.md` 절차 참조).
- Windows Application Control 이 `%TEMP%` 의 Go 테스트 바이너리를 가끔 차단한다(`internal/k8s`). 우회: `go test -c -o .\pkg.test.exe ./internal/k8s; .\pkg.test.exe`.
- dex 를 재시작하면(메모리 스토리지) 서명 키가 바뀌어 kind apiserver 의 JWKS 캐시가 stale → 401. `docker exec kubeport-control-plane sh -c 'touch /etc/kubernetes/manifests/kube-apiserver.yaml'` 로 apiserver 재시작.

## D. 후속 과제 (머지 차단 아님)

리뷰에서 나왔지만 이번 범위 밖으로 넘긴 것. 별도 이슈/PR 로.

- **롤아웃에서 발견 (2026-09-08)**:
  - `dex.staticPasswords` 가 리스트라 `--set hash` 만으로는 email 등이 날아간다. 차트를 `dex.adminPasswordHash` / `dex.userPasswordHash` 스칼라로 바꾸고 템플릿에서 리스트를 조립하면 README 레시피가 단순해진다.
  - 리셋 Job 의 `wipe-k8s` 가 `kube-root-ca.crt` configmap 까지 지운다. `--field-selector metadata.name!=kube-root-ca.crt` 로 제외.
  - `values-oci-phase2.yaml` 은 install 전용이라는 점을 파일 상단 주석에 명시 (업그레이드에 `-f` 금지).
  - GHA `build-images` 의 arm64 프론트 빌드가 QEMU 에서 80분+ 멈춘 적 있음(취소 후 재실행으로 16분). `timeout-minutes` 를 걸거나 arm64 네이티브 러너 검토.

- `DemoBanner.tsx` 의 `react-hooks/set-state-in-effect` lint 에러 → `useSyncExternalStore` 로 재작성하거나 eslint-disable. 같은 패턴이 `MobileSidebarShell.tsx`, `UserFormPreview.tsx` 에도 기존부터 있음.
- Playwright 스펙의 `test.use({ storageState: async ({}, use) => ... })` 가 `react-hooks/rules-of-hooks` 오탐(01~04 스펙 전부). `tests/e2e/**` 를 eslint override 로 제외.
- `DeleteByRelease` 가 **모든** 리소스에서 Forbidden 이면 조용히 성공(DB 행 삭제, k8s 객체 잔존). RBAC 이 잘못 잠긴 계정에서만 발생. 전부 Forbidden 이면 에러로 올리는 분기 추가.
- `demo-user` Role 은 daemonsets / persistentvolumeclaims / networking 이 없다(의도). 데모 템플릿에 그 종류를 넣지 말 것, 넣을 거면 Role 확장.
- `seed-demo`: 버전 0개인 템플릿은 두 번 실행해야 수렴; 리셋 로그의 SQL 30자 절단은 이미 `what` 라벨로 대체됨. `notes` 문구가 한국어 하드코딩.
- 기존 e2e `03-deprecate-flow.spec.ts` 는 main 에서도 실패(ko 로케일 버튼 라벨 vs 영어 정규식). Plan 11 에서 로케일 고정 또는 i18n 키 기반 셀렉터로 수정.
- Plan 11 로 이월된 e2e: demo-user 배포→릴리스 상세→로그, demo-admin 새 버전 저장.
- 프론트 기존 vitest 실패 12건(`RBACCheckPanel`/`InstancesTable`/`LogsPanel`, `NextIntlClientProvider` 누락) — 이 브랜치와 무관, 테스트 래퍼 추가로 해결.
- `kuberport` 오타 → `kubeport` 통일 (docs/oci README·runbook·upload-gha-secrets.sh·CLAUDE.md 잔존).
- 데모 RBAC/policy 객체에 차트 표준 라벨은 이번에 추가했으나, `demo-admin` 이 `pods/exec` 가 필요해지면 명시적으로 검토 후 추가.
- Sentry 피드백 위젯 버튼(배너) 은 Plan 14 에서 SDK 와 함께.

## E. 결정 기록 (구현 중 대신 정한 것)

스펙과 다르거나 스펙이 비워둔 것을 실행 중에 정한 목록. 틀렸다고 판단되면 되돌릴 지점.

| 결정 | 이유 | 되돌리면 |
|---|---|---|
| 데모 팀 `demo` 를 만들지 않고 템플릿은 글로벌 | demo-admin 은 팀 관리가 차단되고 팀이 데모 흐름에 기여 없음 | 팀 라우트 가드 예외 필요 |
| demo-admin 은 인앱 admin 유지 + 데모 소유 객체로 범위 제한 | 템플릿 저작 UX 는 필요하지만 오너 템플릿·전체 릴리스 노출은 불가 | `permissions.go`/`releases.go` 의 demo 분기 제거 |
| Pod Security `baseline` 강제, `restricted` 는 warn/audit | restricted 는 사용자가 쓴 임의 템플릿을 거부해 데모를 혼란스럽게 함 | `demo.podSecurityEnforce=restricted` |
| demo-admin Role 은 워크로드 리소스 명시 목록 | `*` 는 quota/limitrange/netpol 삭제 가능 → 노드 DoS | Role 규칙 확장 |
| OIDC discovery 지연·재시도(5초 타임아웃, 10초 네거티브 캐시) | Dex 미도달 시 backend 기동 실패로 롤아웃이 멈춤 | `multi.go` 의 warm-up 을 fatal 로 |
| 리셋 CronJob `--wait=true`, 릴리스 생성 실패는 Job 실패 | 이전 워크로드 종료 전 재시드 경합, 조용한 빈 데모 방지 | 플래그·에러 처리 원복 |
| `values-oci-phase2.yaml` 은 dex/demo `false` 유지 | 일상 업그레이드가 시크릿 없이 깨지지 않게 | 파일에 `true` + 시크릿 주입 방식 마련 |
| 데모 기본 릴리스명 `템플릿명-xxxx` 는 서버에서 생성 | 원래 기본값이 빈 문자열; 클라이언트 난수는 하이드레이션 불일치 | `defaultName` 제거 |
| 리셋 시 FK 위반은 경고 후 계속 | 오너가 데모 템플릿으로 배포하면 리셋이 영구 실패 | `tolerateFK=false` |
