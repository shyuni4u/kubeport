# 리뷰어 공통 출력 규약

리뷰어는 자유 서술 대신 **아래 YAML 블록 하나**만 최종 응답으로 반환한다.
매니저가 이 블록을 그대로 파싱하므로 형식을 지키지 않으면 결과가 버려진다.

```yaml
persona: user            # user | admin | design | master | security | ai
target: https://kubeport.enzo.kr   # 브라우저 리뷰어만. 코드 리뷰어는 생략
verified:                # 실제로 확인한 범위 (발견 0건이어도 반드시)
  - "카탈로그 → web-app 배포 폼 → 제출 → 릴리스 상세"
  - "frontend/components/DynamicForm.tsx 전체"
unverified:              # 하려 했으나 못 한 것 + 사유 (없으면 [])
  - "로그 탭: 릴리스가 Running 이 되기 전에 타임아웃"
findings:
  - scope: pr            # pr = 이 diff 가 유발·악화 | existing = PR 과 무관한 기존 문제
    severity: P1         # P0 blocker | P1 must-fix | P2 nice-to-have
    impact: blocks-visitor  # blocks-visitor | normal | polish  (아래 "영향도")
    route: issue         # issue(기본) | backlog(이슈 대신 문서로 — 아래 "라우팅")
    title: "배포 폼 제출 실패 시 영문 JSON 이 그대로 노출"
    fingerprint: user/deploy-form/raw-error   # <persona>/<화면 또는 파일 kebab>/<문제 유형 kebab>
    evidence: |
      frontend/components/DynamicForm.tsx:142 `setError(String(err))`
      브라우저: /catalog/web-app/deploy 에서 replicas=-1 제출 → 화면에 {"error":"..."} 표시. 스크린샷 <툴이 돌려준 경로>
    suggestion: |
      setError(t("deploy.submitFailed")) 로 바꾸고
      messages/ko.json "deploy.submitFailed": "배포에 실패했어요. 잠시 후 다시 시도해 주세요."
      messages/en.json "deploy.submitFailed": "Deployment failed. Please try again."
```

## 필드 규칙

| 필드 | 규칙 |
|---|---|
| `scope` | diff 에 없는 파일/화면이면 반드시 `existing`. 확신 없으면 `existing` |
| `severity` | P0 는 **재현 단계 또는 file:line** 이 evidence 에 있을 때만. 데이터 유실·보안·배포 불가·핵심 플로우 중단이 P0 |
| `impact` | 아래 "영향도" 표. 매니저가 이 값을 `sev:*` GitHub 라벨로 옮긴다. 확신 없으면 `normal` |
| `route` | 기본 `issue`. `backlog` 는 **아직 호출자가 없는 신규 표면 요구**뿐 (아래 "라우팅") |
| `title` | 한국어 한 줄, 40자 이내 |
| `fingerprint` | 소문자 kebab, 슬래시 2개. 같은 문제는 실행마다 같은 값이 나오게 화면/파일 이름을 안정적으로 |
| `evidence` | 코드는 `path:line` + 인용. 브라우저는 URL + 밟은 단계 + 스크린샷 참조(아래 "스크린샷 증거" 규칙) + 콘솔 에러 원문 |
| `suggestion` | 바로 적용 가능한 수준. 코드는 before→after, 문서는 문장, UI 는 요소와 변경 내용. 사용자향 문자열은 `messages/ko.json` + `messages/en.json` 양쪽 |

## 스크린샷 증거 (브라우저 리뷰어)

Chrome 확장은 스크린샷을 **두 가지 방식**으로 돌려준다. 어느 쪽인지 리뷰어가 고를 수 없다.

| 툴이 돌려준 것 | evidence 에 적는 것 |
|---|---|
| 파일 경로 (`…\claude-chrome-screenshots-XXXX\screenshot-<ts>-N.jpg`) | 경로 그대로. 오케스트레이터가 리뷰 후 `SHOT_DIR/<persona>/` 로 복사한다 |
| ID 만 (`ss_xxxx`) — 디스크에 저장되지 않음 | `ss_xxxx` + **화면에 보이는 것 1~2문장** (예: "권한 확인 카드 빨간 ❌ 3줄, 그 아래 배포하기 버튼 indigo 활성") |

ID 만 받은 경우 스크린샷은 사후 검증이 불가능하므로 **DOM 근거를 반드시 덧붙인다**: `get_page_text` / `find` 의 텍스트, 또는 `javascript_tool` 로 읽은 computed style·disabled·aria 값. 이 두 가지(설명 + DOM 값)가 있으면 스크린샷 파일이 없어도 근거로 인정된다. 없으면 `unverified` 로.

## 영향도 (`impact`)

심각도(`severity`)가 "얼마나 나쁜가" 라면 영향도는 **"누가 실제로 겪는가"** 다. 둘은 다르다 —
치명적인 결함도 아무도 도달할 수 없는 경로에 있으면 `polish` 일 수 있고,
사소한 오타도 로그인 화면에 있으면 `blocks-visitor` 다.

| 값 | 기준 | 예 |
|---|---|---|
| `blocks-visitor` | 라이브 데모 첫 방문자 또는 리포 첫 설치자가 **실제로 막힌다** | 기본값 helm install 이 ImagePullBackOff (#89), 데모 비밀번호를 눈으로 못 읽음 (#132), 대표 템플릿 편집 불가 (#129) |
| `normal` | 진짜 결함이지만 우회 가능하거나 첫인상 경로가 아니다 | 로컬 compose 의 dex 노출 (#63), 로그 타임스탬프가 수신 시각 (#131) |
| `polish` | 다듬기 — 소수점 대비, 문서 앵커, 미래 로드맵 대비 | hover 1.064:1 (#130), README 앵커 깨짐 (#138) |

**`blocks-visitor` 를 남발하지 않는다.** 한 실행에서 3건을 넘으면 기준을 잘못 잡은 것이다.

## 라우팅 (`route`)

기본은 `issue`. **`backlog` 는 아래를 전부 만족할 때만** 쓴다:

1. 현재 동작이 **문서화된 어떤 계약도 위반하지 않는다** (스펙·`openapi.yaml`·`docs/machine-clients.md` 어디에도 약속된 적 없음), **그리고**
2. 요구하는 것이 **아직 존재하지 않는 호출자를 위한 신규 표면**이다 (MCP 서버, 멱등키, 신규 엔드포인트).

`backlog` 항목은 이슈가 되지 않고 [`docs/api-agent-backlog.md`](../../../../docs/api-agent-backlog.md) 에 append 된다.

> **반례 — 이건 `issue` 다.** 스펙에 적힌 필터 파라미터가 조용히 무시됨(#74), `machine-clients.md` 가 약속한 에러 계약의 구멍(#127·#128).
> 이미 한 약속이 지켜지지 않는 것은 신규 표면 요구가 아니라 **버그**다.

## 가드레일 (모든 페르소나 공통)

- **근거 없는 발견 금지.** 파일을 열지 않았거나 화면을 방문하지 않았으면 쓰지 않는다. 추측은 `unverified` 에.
- 발견 0건이면 `findings: []` 와 함께 `verified` 를 채운다.
- **페르소나 밖 영역은 언급하지 않는다.** user 가 보안을, security 가 UI 색상을 말하지 않는다.
- `kubectl`·`helm`·`ssh` 로 프로덕션(`oci-a1`, `kubeport.enzo.kr`)을 조작하지 않는다. 읽기도 하지 않는다.
- **발견 예산.** `scope: pr` 은 최대 10건. `scope: existing` 은 **최대 3건** — 넘치면 severity 높은 순으로 자르고
  `unverified` 에 "existing P2 N건 생략" 을 적는다. 기존 문제는 이 PR 이 만든 게 아니므로 매 실행마다 전량을
  다시 쏟아 내면 트래커만 커지고 우선순위 신호가 죽는다.
- **같은 근본 원인은 한 건으로 묶는다.** 화면 6곳의 대비 미달이 토큰 하나에서 왔으면 finding 은 **1건**이고,
  6곳은 그 evidence 에 표로 넣는다. 측정값 하나에 이슈 하나를 만들지 않는다.
