# `components/ui/` — shadcn 생성물

`slider.tsx`의 `thumbProps`는 #403에서 추가했습니다. 폼 라벨과 설명을 실제 range 입력으로 전달하기 위한 것으로, 재생성 시 보존해야 합니다. 오류 상태는 `DynamicForm`의 Base UI `Field.Root`에서 전달합니다.

이 디렉터리의 파일은 `shadcn` 이 생성합니다. `npx shadcn@latest add <name>` 은 파일을
**통째로 덮어씁니다** — 아래 로컬 수정 목록을 먼저 확인하고, 덮어썼다면 다시 적용하세요.

로컬 수정에는 코드 안에 `LOCAL EDIT (see components/ui/README.md ...)` 주석이 붙어 있습니다.

## 로컬 수정 목록

| 파일 | 수정 | 이유 |
|---|---|---|
| `input.tsx`, `select.tsx`, `native-select.tsx` | `field-styles.ts`의 `fieldControlClass` 공유 | 관리자·사용자 입력을 40px(모바일 44px) 높이, 8px 모서리, `bg-card`·`text-foreground`, 동일한 포커스·오류·비활성 상태로 통일합니다. |
| `label.tsx`, `form.tsx` | `fieldLabelClass`, `fieldDescriptionClass` 공유 | label은 13px 보조색·중간 굵기, 도움말은 13px로 표시합니다. 관리자 속성과 메타데이터도 같은 규칙을 사용합니다. |
| `button.tsx` | 기본 모서리 8px | 입력·선택 컨트롤과 같은 모서리를 사용합니다. |
| `slider.tsx` | Track `bg-muted` → `bg-slider-track`, 두께 `h-1` → `h-1.5` | [#43](https://github.com/shyuni4u/kubeport/issues/43). `globals.css` 의 `--muted` 가 `--background` 와 **같은 oklch 값**이라 기본 `bg-muted` 트랙이 페이지 배경에 묻혀 보이지 않았습니다. `--border` 도 배경 대비 약 1.2:1 이라 부족해, WCAG 1.4.11(비텍스트 UI 3:1)용 전용 토큰 `--slider-track` 을 뒀습니다. |
| `toggle-group.tsx` | 아이템 클래스를 상수 `toggleGroupItemClassName` 으로 뽑고, shadcn 에 없는 `ToggleRadioGroup` / `ToggleRadioGroupItem` 추가 (Base UI `RadioGroup`·`Radio`) | [#325](https://github.com/shyuni4u/kubeport/issues/325). 필수 enum 은 선택 해제가 안 되는데(#323) 토글 버튼(`aria-pressed`)은 "다시 누르면 풀린다" 고 읽힙니다. 라디오 의미(`radiogroup`·`radio`·`aria-checked`, 화살표 이동, 탭 한 번)로 바꾸되 모양은 토글 그룹과 같게 — 같은 클래스 상수를 쓰고, 눌린 모양만 `aria-checked:` 로 겁니다. `DynamicForm.test.tsx` 가 클래스 동일성을 고정합니다. |
| `form.tsx` | `useFormField` 에 `formLabelId`, `FormLabel` 에 그 `id` | #325. `<label for>` 는 `<div role="radiogroup">` 의 이름이 되지 못해, 그룹이 `aria-labelledby` 로 라벨을 가리킵니다. |

## 근본 원인 메모 — 해결됨 ([#71](https://github.com/shyuni4u/kubeport/issues/71))

`--muted` · `--secondary` 가 `--background` 와 동일한 값(`oklch(0.97 0 0)`)이라, 라이트 모드에서
페이지 배경 위에 놓인 `bg-muted` 계열이 전부 보이지 않았습니다. 슬라이더는 그중 하나가 드러난
사례일 뿐이었습니다. 두 토큰을 `oklch(0.93 0 0)` 으로 내려 분리했고, `app/globals.test.ts` 가
"배경과 같아지지 않는다"를 라이트·다크 양쪽에서 고정합니다.

**`--slider-track` 은 그대로 둡니다.** 슬라이더 트랙은 WCAG 1.4.11 이 3:1 을 요구하는 비텍스트
UI 컴포넌트인데, muted 급 채움은 라이트 배경 대비 1.2:1 이 한계라 자릿수가 다릅니다. 이 판단도
`app/globals.test.ts` 가 assertion 으로 갖고 있어, "이제 지워도 되나?" 를 다시 논쟁하지 않아도
됩니다.

### 정정 — #43 당시 이 토큰은 기준을 넘지 못했습니다

위 표에 "3:1 을 넘긴다" 고 적혀 있었지만, `oklch(0.66)` 은 **흰 카드(1.0) 기준 3.11:1 로 계산된
값**이었습니다. 실제로 슬라이더가 놓이는 곳은 배포 폼이고 그건 카드가 아니라 `--background`
(0.97) 위라, 진짜 값은 **2.85:1 — 미달**이었습니다. 통과하는 표면을 골라 잰 셈입니다.

#71 에서 라이트 `0.62`(배경 대비 3.34:1) · 다크 `0.53`(카드 대비 3.39:1) 로 올려 실제 표면에서
기준을 넘겼습니다. `app/globals.test.ts` 는 이제 **두 테마의 모든 표면**을 훑고, 3.0 이 아니라
**3.3** 을 요구합니다 — oklch 는 8비트 채널로 반올림된 뒤 디스플레이 색관리를 거치므로, 서류상
2% 여유로 통과하는 값은 반올림에 기대는 것이기 때문입니다.

### 2026-09-17 추가 통일

업무 화면의 본문·데스크톱 컨트롤은 14px/20px, label·설명은 13px을 사용합니다. 모바일 입력은 16px을 유지합니다. 작은 버튼과 토글/연결된 선택 버튼도 8px 모서리를 사용하며 선택·포커스 표시는 유지합니다. ClusterPicker는 NativeSelect를 공유하고 배포 메타데이터 label은 fieldLabelClass를 공유합니다.
