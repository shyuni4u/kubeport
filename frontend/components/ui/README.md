# `components/ui/` — shadcn 생성물

이 디렉터리의 파일은 `shadcn` 이 생성합니다. `npx shadcn@latest add <name>` 은 파일을
**통째로 덮어씁니다** — 아래 로컬 수정 목록을 먼저 확인하고, 덮어썼다면 다시 적용하세요.

로컬 수정에는 코드 안에 `LOCAL EDIT (see components/ui/README.md ...)` 주석이 붙어 있습니다.

## 로컬 수정 목록

| 파일 | 수정 | 이유 |
|---|---|---|
| `slider.tsx` | Track `bg-muted` → `bg-slider-track`, 두께 `h-1` → `h-1.5` | [#43](https://github.com/shyuni4u/kubeport/issues/43). `globals.css` 의 `--muted` 가 `--background` 와 **같은 oklch 값**이라 기본 `bg-muted` 트랙이 페이지 배경에 묻혀 보이지 않았습니다. `--border` 도 배경 대비 약 1.2:1 이라 부족해, WCAG 1.4.11(비텍스트 UI 3:1)을 넘기는 전용 토큰 `--slider-track` 을 뒀습니다. |

## 근본 원인 메모

`--muted` · `--secondary` 가 `--background` 와 동일한 값(`oklch(0.97 0 0)`)이라, 라이트 모드에서
페이지 배경 위에 놓인 `bg-muted` 계열이 전부 보이지 않습니다 (`hover:bg-muted`, `bg-muted/40` 등).
슬라이더는 그중 하나가 드러난 사례일 뿐입니다. 토큰 자체를 고치는 편이 옳지만 라이트 모드 전역
시각 변경이라 브라우저 확인이 필요해 별도로 트래킹합니다.
