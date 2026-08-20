# 개발 환경 설정 가이드

kubeport 로컬 개발에 필요한 툴 체인과, Windows에서 자주 부딪히는 함정을 피하는 권장 구성을 정리한다.

**언제 읽을 문서인가**
- 새 머신에 kubeport를 처음 클론했을 때
- `go build`, `pnpm dev`, `docker compose up` 중 하나라도 재현되지 않는 실패가 날 때
- Windows 머신인데 빌드가 비정상적으로 느리거나, 파일 잠금(`EBUSY`, "being used by another process") 오류가 날 때

---

## 1. 먼저 확인할 것 (증상 → 원인)

| 증상 | 의심해 볼 원인 |
|------|----------------|
| `go build` 가 간헐적으로 "file is being used by another process" | 리포가 OneDrive 동기화 경로에 있음 |
| `pnpm install` 중 `EBUSY` / `EPERM` / 심볼릭 링크 실패 | 리포가 OneDrive 경로 또는 한글 경로에 있음 |
| Docker 컨테이너 파일 변경이 호스트에 반영 안 됨 / 극도로 느림 | `/mnt/c/...` WSL ↔ Windows 파일시스템 경유 |
| `docker compose up` 에서 postgres 포트 충돌 | 로컬 Postgres 서비스가 이미 실행 중 |
| `atlas` / `kubectl` / `pnpm` "command not found" | PATH 미설정, 또는 Windows 쪽 설치와 WSL 쪽 설치가 섞임 |

---

## 2. 권장 구성 (Windows) — 3단계

**핵심 원칙**: 코드는 **Linux 파일시스템 위**(WSL 홈)에서 살고, 에디터만 Windows에서 띄운다. Docker도 WSL 내부에서 동작하도록 통합한다.

### Step 1. 리포를 OneDrive 밖으로 옮긴다 (최우선, 5분)

OneDrive는 빌드 산출물(`node_modules/`, `.next/`, `backend/bin/`, `go` 모듈 캐시) 을 실시간 sync 하려다 파일 잠금을 유발한다. 한글 경로는 일부 Node 패키지·오래된 Go 툴체인에서 깨진다.

```powershell
# PowerShell 예시
# 작업 중이면 먼저 commit/stash
git status
git add -A && git commit -m "wip"   # or: git stash

# 이동 (ASCII 짧은 경로로)
mkdir C:\dev
robocopy "C:\Users\shyun\OneDrive\바탕 화면\Developer\kubeport" C:\dev\kubeport /E /MOVE
cd C:\dev\kubeport
git status   # 정상인지 확인
```

> **확인**: 경로에 공백·한글·`OneDrive` 가 없어야 한다. `C:\dev\<repo>`, `D:\src\<repo>` 같은 짧은 ASCII 경로가 이상적.

### Step 2. WSL2 + Ubuntu

```powershell
# PowerShell (관리자)
wsl --install -d Ubuntu
# 재부팅 후 Ubuntu 첫 실행에서 유저/비밀번호 설정
```

리포를 **WSL 홈** 으로 다시 옮긴다. `/mnt/c/...` 는 파일 IO 가 5~20배 느리다.

```bash
# WSL Ubuntu 터미널
mkdir -p ~/dev
# Windows 쪽 C:\dev\kubeport 를 WSL 홈으로 옮기거나, 새로 clone
cd ~/dev
git clone <repo-url> kubeport
cd kubeport
```

### Step 3. 툴 설치 (WSL 안에서)

```bash
# Node.js LTS (nvm 경유 — 버전 전환 쉬움)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install --lts
npm install -g pnpm

# Go (go.mod 가 요구하는 버전 이상)
# https://go.dev/dl/ 에서 최신 stable 확인 후
GO_VERSION=1.22.5
wget https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz
sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf go${GO_VERSION}.linux-amd64.tar.gz
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc
source ~/.bashrc

# Atlas (DB 마이그레이션)
curl -sSf https://atlasgo.sh | sh

# kubectl (나중에 k8s 타겟 클러스터 테스트용)
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl && rm kubectl

# (선택) k3d — 로컬 k3s 클러스터
curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash
```

### Step 4. Docker Desktop WSL 통합

1. Windows 에 [Docker Desktop](https://www.docker.com/products/docker-desktop/) 설치.
2. Docker Desktop → Settings → Resources → **WSL Integration** → `Ubuntu` 체크.
3. WSL 터미널에서 `docker ps` 가 에러 없이 동작하면 성공.

이제 `docker compose` 가 WSL 안에서 네이티브 속도로 돈다.

### Step 5. VS Code Remote-WSL

1. Windows 에 [VS Code](https://code.visualstudio.com/) 설치.
2. 확장 설치: `Remote - WSL` (ms-vscode-remote.remote-wsl).
3. WSL 터미널에서 `code ~/dev/kubeport` 실행 → VS Code 가 WSL 백엔드로 열린다.
4. 확장(Go, ESLint, Prettier 등) 은 **"WSL: Ubuntu" 컨텍스트에 설치** — 좌측 하단 초록색 표시로 확인.

---

## 3. macOS / Linux

훨씬 단순. Homebrew 나 `apt` 로 설치하면 끝.

```bash
# macOS (Homebrew)
brew install go node pnpm atlas-go kubectl
brew install --cask docker   # Docker Desktop

# Ubuntu/Debian (상기 WSL 설치 스크립트 그대로)
```

경로는 한글·공백 피하고 `$HOME/dev/kubeport` 정도면 충분.

---

## 4. 검증 (세팅 완료됐는지 체크)

```bash
cd <repo root>

# 1. 버전 출력이 전부 나오는지
docker --version
docker compose version
go version          # go.mod 의 요구 버전 이상이어야 함
node -v             # LTS (현재 Plan 기준 20.x 이상)
pnpm -v
atlas version
kubectl version --client

# 2. 백엔드 테스트 한 번 (Plan 1 Task 2 이후 의미 있음)
cd backend
go test ./...

# 3. docker compose 가 Plan 1 Task 4 에서 추가되면
#   docker compose -f deploy/docker/docker-compose.yml up -d
#   docker compose ps   # postgres, dex, adminer 전부 healthy
```

모두 통과하면 개발 환경 OK.

---

## 5. Devcontainer (향후)

Plan 1 Task 4 (`deploy/docker/docker-compose.yml`) 를 구현할 때 함께 `.devcontainer/devcontainer.json` 도 추가하는 것을 검토. 목표:

- VS Code에서 "Reopen in Container" 한 번으로 Go + Node + pnpm + atlas + kubectl 버전 고정 환경이 뜸.
- 신규 기기에서 클론 직후 툴 수동 설치 0.
- CI 와 동일한 이미지 기반 → "내 머신에선 되던데" 제거.

현재는 docker-compose 조차 없는 상태라 **먼저 Task 4 를 끝내고 그 위에 devcontainer 를 얹는다** 순서가 자연스럽다.

---

## 6. 흔한 함정 체크리스트

- [ ] 리포가 OneDrive/iCloud 동기화 경로 밖에 있는가
- [ ] 경로에 공백·한글·비ASCII 문자가 없는가
- [ ] Windows 라면 코드가 `/mnt/c/...` 가 아닌 **WSL 홈(`~/dev/...`)** 에 있는가
- [ ] Docker Desktop 의 WSL Integration 이 Ubuntu 에 대해 켜져 있는가
- [ ] `which go`, `which node` 결과가 WSL 경로(`/usr/local/go/bin/go`, `~/.nvm/...`) 인가 — Windows 쪽 설치가 섞여 있지 않은가
- [ ] `git config --global core.autocrlf` 가 `input` 또는 `false` 인가 (WSL/Linux 에서 CRLF 유입 방지)
- [ ] OIDC / DB / 암호화 키 등 `.env` 파일 값은 docker-compose 가 제공하는 개발용 기본값을 그대로 사용 (절대 Secrets 매니저 등 prod 에 쓰지 않는 값)

---

## 7. 관련 문서

- 전체 기술 스택: [CLAUDE.md](../CLAUDE.md)
- 아키텍처: [docs/superpowers/specs/2026-04-16-initial-design.md](superpowers/specs/2026-04-16-initial-design.md)
- Plan 1 (Task 1 저장소 초기화, Task 4 docker-compose): [docs/superpowers/plans/2026-04-16-mvp-1-vertical-slice.md](superpowers/plans/2026-04-16-mvp-1-vertical-slice.md)
