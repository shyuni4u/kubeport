# kubeport QA 체크리스트

Plan 0–5 로 구현된 기능을 **직접 클릭하면서 확인**하기 위한 체크리스트.
로컬 테스트 환경 기준 (`docs/local-e2e.md` §4–10 까지 완료된 상태).

동료에게 넘기기 전에 본인이 한 번 훑고, 이상한 것은 `docs/qa-feedback.md` (추후 생성) 로 기록.

---

## 0. 사전 확인

- [ ] `docker compose -f deploy/docker/docker-compose.yml ps` → postgres + dex 가 `Up (healthy)`
      (dex 가 안 뜨면 `deploy/docker/certs/dex.{crt,key}` 가 없는 것 — 생성은 [docs/dev-setup.md §4](dev-setup.md))
- [ ] `kubectl --context kind-kubeport get nodes` → `control-plane` 이 `Ready`
- [ ] `curl -s http://localhost:8080/healthz` → `ok`
- [ ] `http://localhost:3000` 접속 → 로그인 화면 표시 (dex 로 리다이렉트)
- [ ] `local-e2e.md §9` 의 cluster 등록 + `web` 템플릿 seed 완료

---

## 1. 인증 / 역할 배지

- [ ] `admin@example.com / admin` 으로 로그인 성공, 카탈로그로 진입
- [ ] TopBar 우측에 **"Admin · 템플릿 작성"** 보라색 배지 표시
- [ ] `/admin/teams` / `/templates/new` 접근 가능
- [ ] 로그아웃 → `alice@example.com / alice` 로 재로그인
- [ ] TopBar 우측에 **"User · 카탈로그 소비"** 청록 배지 표시
- [ ] alice 가 `/admin/teams` 진입 시도 → 403 또는 리다이렉트
- [ ] TopBar 사용자 메뉴에 이메일·로그아웃 항목 표시

---

## 2. 관리자 — 팀 관리 (`/admin/teams`)

- [ ] 팀 생성: 이름(slug)·표시 이름 입력 → 저장 → 목록에 추가됨
- [ ] 팀 상세 진입: 이름 클릭 → `/admin/teams/:id`
- [ ] 팀에 멤버 추가 (이메일 + role=editor/viewer)
- [ ] 멤버 role 변경 (editor ↔ viewer)
- [ ] 멤버 제거
- [ ] 팀 이름(slug)·표시 이름 수정
- [ ] 이미 존재하는 팀 이름으로 생성 시도 → 에러 메시지

---

## 3. 관리자 — 템플릿 생성 (UI 모드, `/templates/new?mode=ui`)

### 3.1 리소스 선택 + 기본 MetaRow
- [ ] 리소스 타입 선택 (Deployment / Service / …)
- [ ] MetaRow: name / display_name / team / tags 입력 가능
- [ ] name 은 DNS-safe (소문자/하이픈/숫자만) 아니면 경고

### 3.2 SchemaTree + FieldInspector (필드 노출/고정 마킹)
- [ ] 왼쪽: YAML 미리보기 (Monaco, dark)
- [ ] 가운데: SchemaTree — spec 의 필드 트리 표시
- [ ] 오른쪽: FieldInspector — 필드 클릭 시 모드 선택 UI
- [ ] `spec.replicas` 클릭 → "사용자 노출" 선택 → label/min/max/default 입력 → SchemaTree 에 **초록 "exposed" 배지**
- [ ] 컨테이너 `image` 클릭 → "값 고정" = `nginx:1.25` → SchemaTree 에 **회색 "fixed" 배지**
- [ ] enum type 선택 시 values 편집기 노출 (예: env 문자열 목록)
- [ ] ResizablePanelGroup: 왼쪽·가운데·오른쪽 경계 드래그로 너비 조정 가능

### 3.3 BottomBar — 저장·발행
- [ ] "초안 저장" → 템플릿 생성됨, `/templates/<name>` 로 이동
- [ ] "발행" (v1 publish) → StatusChip 이 `published` (green)
- [ ] 발행 후에도 편집 가능하나 **새 버전** 생성을 유도

### 3.4 ?mode=yaml 분기
- [ ] `/templates/new?mode=yaml` → Monaco 에서 `resources.yaml` + `ui-spec.yaml` 직접 편집
- [ ] 저장 시 ui-spec 파싱 오류가 있으면 BottomBar 가 저장 차단 + 오류 위치 표시

---

## 4. 관리자 — 기존 템플릿 편집

### 4.1 메타만 수정 (`PATCH /v1/templates/:name`)
- [ ] `/templates/<name>/edit` 진입
- [ ] display_name 변경 → 저장 → `/catalog` 카드에 즉시 반영
- [ ] tags 추가·제거 → 저장 → `/catalog` 태그 필터에 반영
- [ ] 앞뒤 공백 입력 시 **trim 후 저장** (PR #21 Gemini 리뷰 항목)

### 4.2 새 버전 에디트 (`/templates/:name/versions/:v/edit`)
- [ ] v2 draft 생성 → UI 모드로 필드 변경 → 저장 → 버전 목록에 v2 draft 표시
- [ ] v2 publish → `current_version` 이 2 로 갱신
- [ ] v1 의 기존 릴리스는 여전히 v1 에 pin (릴리스 상세 페이지에서 확인)
- [ ] YAML 로 작성된 draft(시드 `web-app` draft 등)를 `?mode=ui` 로 열기 → 상단 배너가 "미리보기만 가능" 과 YAML 모드 탭 편집을 안내하고, 필드 클릭 시 인스펙터 위에 "볼 수만 있고 저장할 수 없습니다" 노트와 "YAML 모드에서 편집" 링크가 보이며, 인스펙터·표시 이름·태그 입력이 모두 비활성이고 저장 버튼이 꺼져 있다 (#184)
- [ ] 노트의 "YAML 모드에서 편집" 링크 → `?mode=yaml` 로 이동(미저장 확인창 없음) → 수정 후 저장 → 상세 페이지로 이동, draft 에 반영됨
- [ ] 편집 화면(UI·YAML 모드 각각)을 연 직후 저장 버튼 옆에 "저장하지 않은 변경 사항이 있습니다" 가 없다 → 한 글자 입력하면 표시되고 다른 모드 탭 클릭 시 확인창이 뜬다 → 입력을 지워 원래대로 되돌리면 표시가 사라지고 탭 클릭 시 확인창이 뜨지 않는다 (#274)

### 4.3 deprecate
- [ ] v1 deprecate → `/catalog` 에서 해당 템플릿 카드 사라짐 (또는 숨김 토글)
- [ ] 이미 배포된 릴리스는 유지되나, 새 배포 시도 시 400

---

## 5. 사용자 — 카탈로그 (`/catalog`)

- [ ] 페이지 로드 시 published 템플릿만 카드로 표시
- [ ] 각 카드: display_name, tags, 리소스 아이콘 (Deployment / Service / …)
- [ ] **검색 박스** — display_name / name / tags 부분일치
- [ ] **태그 필터** — 멀티 선택 / 해제
- [ ] 필터 조합 (검색 + 태그) 동작
- [ ] 카드 클릭 → `/catalog/<name>` 로 이동
- [ ] 버전 목록에서 특정 버전 선택 → `/catalog/<name>/versions/<v>/deploy`
- [ ] **초안 가시성** — 관리자로 v2 draft 생성 → 그 팀에 속하지 않은 일반 사용자로 로그인 →
      `/templates/<name>` 버전 목록에 draft 가 없고, 한 번도 publish 안 된 템플릿은 `/catalog`·`/templates`
      목록에도 안 보인다. 같은 팀의 `viewer` 멤버에게는 보인다 (열람만, 편집·삭제는 403)

---

## 6. 사용자 — 배포 폼

### 6.1 DynamicForm (`/catalog/:name/deploy`)
- [ ] ui-spec 의 "사용자 노출" 필드만 입력 UI 로 렌더됨
- [ ] "값 고정" 필드는 폼에 나오지 않음 (서버에서 강제 주입됨)
- [ ] integer 필드: min/max 벗어나면 Zod 에러
- [ ] 필수 필드 비우면 submit 비활성화
- [ ] 배포 이름이 비어 있으면 입력칸 아래 회색 안내("배포 이름을 입력하면 배포할 수 있습니다.") + 버튼 비활성 — 빨간 에러는 아님 (#182)
- [ ] 배포 이름에 대문자·공백·밑줄·점, 또는 하이픈으로 시작/끝나는 값(예: `Web App 배포 테스트 1`) → 입력 즉시 빨간 안내 + 빨간 테두리 + 버튼 비활성, 제출 전에 알 수 있음. 고치면 안내가 사라지고 버튼이 켜짐 (#182)
- [ ] 배포 이름은 63자에서 더 입력되지 않음 (#182)
- [ ] default 값 자동 세팅
- [ ] 실시간 YAML 프리뷰 패널: 입력값 반영되어 렌더된 최종 YAML 표시
- [ ] 디바운스 동작 (타자 칠 때마다 깜빡이지 않음)

### 6.2 클러스터 드롭다운 (Plan 5)
- [ ] 클러스터가 2 개 이상 등록되어 있으면 드롭다운 노출 (1 개뿐이면 숨김 또는 단일 옵션)
- [ ] 선택한 클러스터에 따라 RBAC 패널이 다시 판정됨

### 6.3 RBAC 패널 (SSAR)
- [ ] 권한 있는 namespace: 초록 체크 + "배포" 버튼 활성화
- [ ] 권한 없는 namespace: 빨간 경고 + 버튼 비활성화
- [ ] namespace 전환 시 재판정
- [ ] RBAC 판정 중("확인 중…")이거나 판정 자체가 실패(HTTP 오류)했을 때는 배포 버튼이 막히지 않음 — 거부로 판정된 경우에만 비활성화 (fail-open, #30)
- [ ] 빨간 거부 문구가 보이는 순간 배포 버튼이 이미 비활성화되어 있음 (#99 — 1커밋 간격이라 눈으로는 못 보고 `frontend/components/RBACCheckPanel.same-commit.test.tsx` 가 자동 검증)
- [ ] 권한 확인 중에 미리보기 렌더가 실패해 확인할 리소스가 비면(폼 값을 렌더가 거절하는 값으로 바꾸기) 패널이 "확인 중…" 에 멈추지 않는다 — 구역을 지우면 패널 자체가 사라지는 게 정상 (#99)

### 6.4 제출
- [ ] submit → `/releases/<id>` 로 이동, StatusChip `deploying`
- [ ] 수 초 후 `healthy` 로 변경 (pod ready 이후)
- [ ] `kubectl -n default get deploy,svc` 로 실제 리소스 생성 확인

### 6.5 업데이트 플로우
- [ ] 기존 릴리스의 "업데이트" 버튼 → 새 버전 선택 → 배포 폼 열림 (`?updateReleaseId=<id>`)
- [ ] 기존 값이 폼에 pre-fill 됨
- [ ] 업데이트 submit → 기존 릴리스의 `current_version` 이 증가, 새 리소스 apply

---

## 7. 사용자 — 릴리스 상세 (`/releases/[id]`)

### 7.1 개요 탭
- [ ] 릴리스 메타: 템플릿명, 버전, 클러스터, namespace, 생성자, 생성시각
- [ ] StatusChip: healthy / deploying / failed / deprecated
- [ ] UpdateAvailableBadge: `current_version < latest_published_version` 일 때 "업데이트 가능" 표시
- [ ] 리소스 목록: Deployment → replicas (ready/desired), Service → ClusterIP, …
- [ ] "편집 (업데이트)" 버튼 → 배포 폼 업데이트 모드
- [ ] "삭제" 버튼 → 확인 다이얼로그 → 실제 리소스 제거 + 릴리스 레코드 soft-delete

### 7.2 로그 탭 (SSE)
- [ ] Deployment pod 목록 노출 (2 replicas → 2 pods)
- [ ] pod 선택 시 로그 실시간 스트리밍 (SSE)
- [ ] `kubectl -n default exec <pod> -- sh -c 'echo hello >&2'` 로 로그 생성 시 UI 에 반영
- [ ] pod 재시작 시 스트림 끊김 → 자동 재연결 or 안내 메시지
- [ ] 탭 이동 시 스트림 정상 종료 (리소스 누수 방지)

---

## 8. 멀티 클러스터

- [ ] 두 번째 클러스터 등록 (`POST /v1/clusters`) — 이름 `kind2` 등
- [ ] 배포 폼에서 클러스터 선택 시 RBAC 판정 / 실제 배포 대상이 바뀜
- [ ] 릴리스 상세에 클러스터명 표시

---

## 9. 에러 / 엣지케이스

- [ ] 백엔드 내려간 상태에서 프론트 접근 → 사용자 친화적 에러 (흰 화면 금지)
- [ ] 만료된 세션 → 로그인 재유도
- [ ] 유효하지 않은 YAML 저장 시도 → 저장 차단
- [ ] 중복 name 템플릿 생성 → 400
- [ ] 존재하지 않는 릴리스 URL (`/releases/999999`) → 404 페이지
- [ ] 네트워크 일시 끊김 후 복구 시 재연결 (SSE, 카탈로그)
- [ ] 아주 긴 display_name / 매우 많은 tags → UI 가 깨지지 않음
- [ ] 한글/이모지 입력 값이 YAML 렌더에 반영될 때 escape 정상

---

## 10. 알려진 한계 (QA 아님, 참고용)

아래는 "버그" 가 아니라 의도된 상태. 체크할 필요 없음.

- `KBP_DEV_ADMIN_EMAILS` 로 관리자 판정 → 로컬 한정. 프로덕션은 IdP groups claim 사용.
- `system:authenticated → edit` 바인딩 → 로컬 한정. 프로덕션은 그룹별 RBAC.
- **k8s 용어 토글은 역할별 기본값으로 시작한다** (#39) — `kubeport-admin`(또는 `auth.devAdminEmails`) 계정은 원본 용어(`ConfigMap`, `create · <ns>`), 일반 사용자는 쉬운 말(`설정`, `<ns> 구역에 만들기`)로 시작한다. 릴리스 상세 헤더와 배포 폼 미리보기에 같은 토글이 있고, 방문 중에 한 번 바꾸면 그 선택이 유지된다(새로고침 시 역할 기본값으로). `frontend/lib/kube-kinds.ts` 의 `KNOWN_KINDS` 밖의 kind·CRD 는 토글과 무관하게 원본 이름으로 보인다.
- **클러스터 DELETE API 미구현** — `backend/internal/api/routes.go` 에 핸들러 없음. 제거 시 DB 에서 직접 삭제해야 함.
- Helm chart 미구현 (다음 단계)
- 풀스택 e2e runner (Task 22) 미구현
- CRD 지원 없음 (v1.1 예정)
- 템플릿 Git 연동 없음 (v2 예정)

---

## 피드백 기록 방법

QA 중 발견한 이슈는 아래 형식으로 `docs/qa-feedback.md` 에 누적 (파일은 처음 발견 시 생성):

```md
### [심각도] 간단한 제목
- **화면**: /catalog or /templates/new 등
- **단계**: 1. … 2. … 3. …
- **기대**: …
- **실제**: …
- **심각도**: blocker / major / minor / nit
- **스크린샷/로그**: (선택)
```

심각도 가이드:
- **blocker**: 그 플로우가 전혀 안 됨. 동료 배포 전 반드시 수정.
- **major**: 동작은 하나 잘못된 결과. 동료 배포 전 수정 권장.
- **minor**: UX 불편. 동료 피드백과 함께 수집.
- **nit**: 사소한 문구/여백. 배치 수정.
