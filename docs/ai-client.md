# AI에서 내 kubeport 사용하기

kubeport는 **Skill + 로컬 호출 스크립트**를 제공한다. 사용자의 AI 실행 환경이
사용자가 설치한 kubeport에 직접 연결한다. `kubeport.enzo.kr`의 인증이나 중앙
중계 서버, 별도 MCP 서비스는 필요 없다. 공개 데모를 선택한 경우에만 그 데모에 연결된다.

## 설치와 로그인

요구 사항: Node.js 22 이상, 설치본에 대한 네트워크 접근, 이 기능을 포함한 kubeport 버전.
관리자는 기존 브라우저 OIDC 로그인과 `PUBLIC_ORIGIN` 또는 `OIDC_REDIRECT_URI`를 설정한다.
추가 OAuth 클라이언트·콜백 등록이나 DB 마이그레이션은 없다. 기존 Helm 배포의 프론트
이미지를 업데이트하면 경로가 함께 제공된다. 백엔드를 외부에 노출하지 않는다.

1. 저장소의 [`skills/kubeport`](../skills/kubeport)를 사용 중인 에이전트의 Skill 폴더에
   복사한다. `SKILL.md`, `scripts`, `references`를 함께 유지한다. Codex에서 프로젝트에
   한정해 쓰려면 해당 프로젝트의 `.agents/skills/kubeport/`에 둔다. 다른 에이전트는
   그 제품의 Skill 설치 경로를 사용하며 Node 실행 권한이 있어야 한다.
2. **사용자 자신의 터미널**에서 다음을 실행한다. URL은 자기 설치본으로 바꾼다.

   ```sh
   node skills/kubeport/scripts/kubeport.mjs login --url https://kubeport.example.org
   ```

3. 출력된 `/cli` 주소를 브라우저로 열어 로그인한다. 사용자 메뉴의 **AI · CLI 연결**로도
   갈 수 있다. 계정을 확인하고 **연결 토큰 발급**을 누른다.
4. 토큰을 터미널의 숨겨진 입력란에 붙여넣는다. AI 대화나 명령 인자로 넘기지 않는다.
   도구가 `/v1/me`로 신원을 확인하고 로컬에 연결 정보를 저장한다.
5. AI에 “kubeport에서 배포 가능한 템플릿을 보여줘”처럼 요청한다.

복사 설치 후에는 위 명령의 스크립트 경로를 실제 설치 위치로 바꾼다. 중앙 도메인이나
사전 발급된 공용 인증 정보는 스크립트에 들어 있지 않다.

## 직접 호출하기

```sh
node skills/kubeport/scripts/kubeport.mjs whoami
node skills/kubeport/scripts/kubeport.mjs clusters
node skills/kubeport/scripts/kubeport.mjs templates
node skills/kubeport/scripts/kubeport.mjs templates web-app 1
node skills/kubeport/scripts/kubeport.mjs render web-app --version 1 --file values.json
node skills/kubeport/scripts/kubeport.mjs deploy --file release.json
node skills/kubeport/scripts/kubeport.mjs releases
node skills/kubeport/scripts/kubeport.mjs logs RELEASE_ID --seconds 10
```

`values.json`은 해당 템플릿의 입력 값 객체다. 배포용 `release.json`의 모양은 다음과 같다.
이름·버전·클러스터·네임스페이스·입력 값은 실제 조회 결과로 정한다.

```json
{
  "template": "web-app",
  "version": 1,
  "cluster": "development",
  "namespace": "my-team",
  "name": "my-app",
  "values": {}
}
```

`render`는 순수 렌더 미리보기다. Kubernetes의 권한·admission 검사나 실제 적용 성공을
보장하지 않는다. `update ID --file update.json`은 `{ "version": 1, "values": {} }`를
받고, `delete ID`는 실제 삭제한다. 일반 API가 필요하면
`api GET '/v1/releases?cluster=development&limit=20&offset=0'`처럼 호출한다.
API 상세 계약은 [`backend/api/openapi.yaml`](../backend/api/openapi.yaml)을 따른다.

성공·실패 모두 JSON으로 출력하고 실패 시 종료 코드 1을 반환한다. 로그는 기본 10초,
최대 60초/1 MiB의 SSE 관찰 결과를 JSON으로 반환한다. `truncated`면 관찰이 제한됐다는
뜻이며 `error` 이벤트는 HTTP 200이어도 실패다. 자동 재연결이나 쓰기 재시도는 없다.

## 인증과 권한

```text
로컬 AI + Skill/스크립트
  → 내 설치본 /api/cli/v1/* (설치본에 묶인 연결 토큰)
  → 기존 Go /v1/* (현재 사용자의 OIDC 토큰)
  → Kubernetes (같은 사용자의 RBAC)
```

- 토큰은 현재 브라우저 세션을 가리키는 암호화된 자격 증명이다. 세션 ID와 OIDC 토큰을
  클라이언트에 공개하지 않는다. 앱의 기존 암호화 키에서 용도별 키를 파생한다.
- 최대 **1시간** 유효하다. 브라우저 세션 만료·삭제, OIDC 갱신 실패 시 더 일찍 끝날 수 있다.
  원래 세션에서 로그아웃하면 그 세션이 발급한 토큰은 모두 무효다.
- 읽기 전용 토큰이 아니다. 현재 사용자의 생성·변경·삭제 권한과 데모 제한이 그대로 적용된다.
  API 요청마다 기존 세션 유효성·사용자 권한을 검사한다.
- `POST /api/auth/cli-token`은 브라우저 로그인과 신뢰하는 Origin을 모두 요구한다.
  인증·CLI API 응답은 `Cache-Control: no-store`다. 토큰 발급에는 명시적인 버튼 클릭이 필요하다.
- 기존 `/api/v1/*`는 여전히 세션 쿠키 전용이다. CLI 토큰은 `/api/cli/v1/*`에서만 해석하며
  원시 OIDC 토큰이나 브라우저 쿠키로 CLI 경로에 접근할 수 없다.
- `logout` 명령은 **로컬 파일만 삭제**한다. 서버에서 취소하려면 발급한 브라우저 세션에서
  로그아웃한다. 다른 브라우저 로그아웃이나 새 토큰 발급으로 기존 토큰이 취소되지는 않는다.
- 이 버전은 사람이 로그인한 뒤 AI와 작업하는 용도다. 장시간 무인 CI·서비스 계정,
  세분화된 토큰 scope·개별 토큰 폐기는 별도 과제다.

## 설정과 문제 해결

연결 정보 기본 위치는 `~/.kubeport/credentials.json`이다. POSIX에서는 새 디렉터리/파일을
0700/0600으로 생성하며 Windows에서는 사용자 홈의 ACL을 상속한다. 사용자 전용 홈을 쓰고
공유 폴더·저장소·동기화 폴더에 자격 증명을 두지 않는다.

`KUBEPORT_CONFIG`로 설치본·에이전트별 파일을 분리할 수 있다. 비밀 관리 기능이 있는
환경에서는 `KUBEPORT_URL`과 `KUBEPORT_TOKEN`을 주입해 로컬 저장 없이 호출할 수도 있다.
환경 토큰은 저장된 토큰보다 우선한다. 토큰을 대화에 출력하거나 소스에 기록하지 않는다.

- **401**: `/cli`에서 다시 로그인/발급하고 `login`한다. 만료된 토큰을 반복 재시도하지 않는다.
- **404 또는 JSON이 아닌 응답**: 주소가 자기 설치본인지, 이 기능이 포함된 버전인지 확인한다.
- **403**: 현재 사용자 권한 또는 데모 제한을 확인한다. 다른 계정이나 `force=true`로 자동 우회하지 않는다.
- **연결 오류**: AI 실행 환경의 VPN·DNS·TLS를 확인한다. HTTP는 localhost/127.0.0.1/::1 개발 환경만 허용한다.
- **쓰기 시간 초과**: 릴리스 목록/상세에서 실제 결과를 먼저 확인한다. 서버에 멱등 키가 없으므로
  성공 응답을 받지 못했다는 이유만으로 재배포하지 않는다.

검증: `node --test tests/cli/kubeport.test.mjs`, 프론트의 CLI 토큰·API·연결 화면 테스트.
