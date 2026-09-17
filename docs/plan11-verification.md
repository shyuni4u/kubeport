# Plan 11 검증 기록

## 2026-09-17

### 로컬 장애·복구

`09-release-recovery.spec.ts`를 실제 Windows 로컬 앱 + Dex + PostgreSQL +
kind(Kubernetes v1.35.0)에서 실행했다. 개별 실행 1개 테스트 통과(13.8초).

- 실제 nginx Deployment가 `healthy`가 됨.
- 테스트 전용 TCP 프록시 차단 시 API `cluster-unreachable`와 브라우저 안내가 일치함.
- 프록시 복구 후 동일 릴리스 ID가 유지되고 `healthy`로 돌아옴.
- Pod 조회는 허용하고 `pods/log`만 거부하면 HTTP 200 SSE가 열리고 한국어 권한 오류가 표시됨. Kubernetes 내부 오류 원문은 표시하지 않음.
- 권한 복구 후 실제 nginx 시작 로그가 표시됨.
- 해당 릴리스 UID의 Deployment·Service·ConfigMap을 외부 삭제하면 `resources-missing`와 안내가 표시됨.
- 일반 사용자에게 강제 삭제 버튼이 없으며 직접 API 요청도 `403 rbac-denied`. 기록은 유지됨.
- 관리자의 확인 대화상자를 거친 강제 삭제 후 상세 API `404`.
- 성공/실패 모두 테스트 생성 리소스·등록 정리를 수행. 첫 실행의 문구 매칭 실패 때도 정리 경로가 실행됨.

전체 로컬 Playwright **15개 통과(51.9초)**, TypeScript와 변경 테스트 파일
ESLint 통과. 기존 `05-user-deploy`가 오래된 DB fixture 클러스터를 선택하던
문제를 실제 `kind` 명시 선택으로 고쳤고, CI에도 로컬과 같은
`DEMO_NAMESPACE=default`를 적용해 데모 권한 안내를 검증한다.
코드 커밋 `321218c`의 [일반 CI](https://github.com/shyuni4u/kubeport/actions/runs/35188768205)와
[Playwright E2E](https://github.com/shyuni4u/kubeport/actions/runs/35188768176)가 모두 통과했다.
CI에서도 `KBP_RECOVERY_E2E=1`로 복구 시나리오를 실제 실행했다.
첫 CI 실행은 14개 첫 시도 통과 + 기존 `03-deprecate-flow` 1개 재시도 통과
(`published` 화면 표시 대기 timeout)로 종료했다. 새 복구 시나리오는 첫 시도에
통과했으며, 전체가 재시도 없이 통과한 결과로 해석하지 않는다.
이 결과와 아래 운영 smoke를 근거로 [PR #423](https://github.com/shyuni4u/kubeport/pull/423)에서 Plan 11을 완료로 표시한다.

### 운영 smoke

- 대상: `https://kubeport.enzo.kr`, 확인 버전 `db9da58`.
- 2026-09-17 15:01–15:03 KST, 공개 데모 사용자로 브라우저 로그인.
- 카탈로그 → `web-app` 배포 폼 → `oci-a1` / `demo`에 `plan11-smoke-20260917` 생성.
- 릴리스 ID: `7868bbe9-87f1-4dbd-bfda-441acd6458b5`.
- 초기 대기 상태에서 **정상**으로 전환, 로그 탭 **연결됨**과 nginx 시작 로그 확인.
- UI에서 해당 검증 릴리스 삭제 → 목록에서 사라짐 → 상세 재접근 시 찾을 수 없음 안내.
- 운영 VM에서 해당 UID 레이블로 Deployment·ReplicaSet·Pod·Service·ConfigMap 조회: 잔여 객체 없음.
- 데모 사용자 로그아웃, 랜딩의 로그인 링크 확인.

운영에서는 연결 차단·RBAC 변경·외부 리소스 삭제를 수행하지 않았다.
장애 검증은 로컬/CI kind에 한정한다. 이 검증은 Plan 12의 백그라운드
reconciler 구현이나 자동 복구 기능 완료를 의미하지 않는다.
