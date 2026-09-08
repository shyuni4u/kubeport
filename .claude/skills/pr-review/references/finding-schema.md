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
| `title` | 한국어 한 줄, 40자 이내 |
| `fingerprint` | 소문자 kebab, 슬래시 2개. 같은 문제는 실행마다 같은 값이 나오게 화면/파일 이름을 안정적으로 |
| `evidence` | 코드는 `path:line` + 인용. 브라우저는 URL + 밟은 단계 + 스크린샷 경로(브라우저 툴이 돌려준 실제 저장 경로 그대로) + 콘솔 에러 원문 |
| `suggestion` | 바로 적용 가능한 수준. 코드는 before→after, 문서는 문장, UI 는 요소와 변경 내용. 사용자향 문자열은 `messages/ko.json` + `messages/en.json` 양쪽 |

## 가드레일 (모든 페르소나 공통)

- **근거 없는 발견 금지.** 파일을 열지 않았거나 화면을 방문하지 않았으면 쓰지 않는다. 추측은 `unverified` 에.
- 발견 0건이면 `findings: []` 와 함께 `verified` 를 채운다.
- **페르소나 밖 영역은 언급하지 않는다.** user 가 보안을, security 가 UI 색상을 말하지 않는다.
- `kubectl`·`helm`·`ssh` 로 프로덕션(`oci-a1`, `kubeport.enzo.kr`)을 조작하지 않는다. 읽기도 하지 않는다.
- 한 페르소나당 findings 는 최대 10건. 넘치면 severity 높은 순으로 자르고 `unverified` 에 "P2 N건 생략" 을 적는다.
