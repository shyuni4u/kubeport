# Admin UI Editor Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin UI-mode 템플릿 에디터 (`/templates/new`, `/templates/[name]/versions/[v]/edit`) 를 스펙 §3 에 맞춰 재구성 — 고정된 3-col grid → **ResizablePanelGroup**, SchemaTree 에 **fixed/exposed 배지**, FieldInspector 에 **enum values 리스트 편집기**, 상단 **Meta row** (name·team·tags) + 하단 **Sticky bottom bar** (미리보기·Draft 저장·Publish), `?mode=ui|yaml` 쿼리 분기, YamlPreview → MonacoPanel (Plan 0) 로 통합.

**Architecture:** 기존 구현이 이미 많이 있어서 이 플랜은 **재배치 + 소폭 확장**이 대부분. 순서를 신중히 — 각 태스크마다 빌드 통과를 유지하며 점진 전환.

**Tech Stack:** 기존 + Plan 0 산출물 (shadcn Resizable, Tabs, use-debounce, MonacoPanel).

**스펙 참조:** [2026-04-19-frontend-design-spec.md](../specs/2026-04-19-frontend-design-spec.md) §3.

**전제:** Plan 0 완료 (shadcn resizable/tabs/form, use-debounce, MonacoPanel wrapper).

---

### Task 1: `YamlPreview.tsx` → MonacoPanel 으로 내부 교체 + `use-debounce` 전환

**Files:**
- Modify: `frontend/components/YamlPreview.tsx`

현재 YamlPreview 는 `@monaco-editor/react` 를 직접 import + `setTimeout` 으로 debounce 한다. Plan 0 의 `MonacoPanel` 로 교체하고 `useDebouncedCallback` 으로 전환.

- [ ] **Step 1: 현재 코드 스냅샷**

Run: `cat frontend/components/YamlPreview.tsx`
현재 구조 (props, state, preview fetch 로직) 확인.

- [ ] **Step 2: 수정 — Monaco 직접 import 제거 + MonacoPanel 사용 + `useDebouncedCallback`**

핵심 변경 2군데:
1. Monaco import 삭제:
   ```tsx
   // 이전:
   import dynamic from "next/dynamic";
   const Editor = dynamic(() => import("@monaco-editor/react").then((m) => m.default), { ssr: false });
   // 이후:
   import { MonacoPanel } from "./MonacoPanel";
   ```
2. `setTimeout` 기반 debounce → `use-debounce`:
   ```tsx
   import { useDebouncedCallback } from "use-debounce";
   // useEffect 블록 전체를 다음으로 교체:
   const runPreview = useDebouncedCallback(async (state: UIModeTemplate) => {
     const res = await fetch("/api/v1/templates/preview", {
       method: "POST",
       headers: { "Content-Type": "application/json" },
       body: JSON.stringify({ ui_state: state }),
     });
     if (!res.ok) return;
     const body = (await res.json()) as { resources_yaml: string; ui_spec_yaml: string };
     setResourcesYaml(body.resources_yaml);
     setUiSpecYaml(body.ui_spec_yaml);
   }, 300);
   useEffect(() => { runPreview(uiState); }, [uiState, runPreview]);
   ```
3. Monaco 렌더를 `<MonacoPanel value={…} readOnly language="yaml" height={480} />` 로.

- [ ] **Step 3: 타입·린트·빌드 통과**

Run: `cd frontend && pnpm test && pnpm lint && pnpm build`
Expected: 통과. 기존 에디터 페이지들도 자연히 새 구현 사용.

- [ ] **Step 4: 브라우저 스모크**

`/templates/new` 열고 Kind 추가 → YamlPreview 가 여전히 300ms 후 갱신되는지 확인.

- [ ] **Step 5: 커밋**

```bash
git add frontend/components/YamlPreview.tsx
git commit -m "refactor(frontend): YamlPreview uses MonacoPanel + useDebouncedCallback"
```

---

### Task 2: `SchemaTree` — fixed/exposed 배지 추가

**Files:**
- Modify: `frontend/components/SchemaTree.tsx`
- Create: `frontend/components/SchemaTree.test.tsx`

스펙 §3.3 — 트리의 각 노드 우측에 mode 배지:
- `fixed` 는 회색 `Badge variant="muted"` + 라벨 "고정"
- `exposed` 는 `bg-blue-50 text-blue-800` + 라벨 "● exposed"

현재 SchemaTree 가 각 path 에 대해 `fields[path]?.mode` 값을 받을 수 있어야 함. props 확장 필요.

- [ ] **Step 1: 현재 SchemaTree props 구조 확인**

Run: `cat frontend/components/SchemaTree.tsx`
현재 `{ schema, selectedPath, onSelect }` 확인.

- [ ] **Step 2: props 에 `fields: Record<string, { mode: "fixed" | "exposed" }>` 추가**

시그니처 변경:
```tsx
export function SchemaTree({
  schema,
  selectedPath,
  onSelect,
  fields,
}: {
  schema: OpenAPISchema;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  fields?: Record<string, { mode: "fixed" | "exposed" }>;
}) { … }
```

- [ ] **Step 3: 각 노드 렌더 지점에서 배지 삽입**

노드 렌더하는 JSX 내부, 라벨 옆에:
```tsx
{fields?.[path]?.mode === "fixed" && (
  <Badge variant="muted" className="text-[9px]">고정</Badge>
)}
{fields?.[path]?.mode === "exposed" && (
  <span className="rounded-sm bg-blue-50 px-1 text-[9px] text-blue-800">● exposed</span>
)}
```

- [ ] **Step 4: 테스트 — `frontend/components/SchemaTree.test.tsx`** (미니 스키마)

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SchemaTree } from "./SchemaTree";

const miniSchema = {
  /* …의도적으로 복잡해지지 않도록, 실제 스키마 구조에 맞춘 1-level 샘플 객체…
     현재 SchemaTree 구현을 보고 맞출 것. */
} as any;

describe("SchemaTree badges", () => {
  it("renders exposed badge when field mode is exposed", () => {
    render(
      <SchemaTree
        schema={miniSchema}
        selectedPath={null}
        onSelect={() => {}}
        fields={{ "spec.replicas": { mode: "exposed" } }}
      />,
    );
    // 구현상 'spec.replicas' 노드가 렌더되면 exposed 배지가 있어야 함
    const exposed = screen.queryByText("● exposed");
    if (exposed) {
      expect(exposed).toBeInTheDocument();
    } else {
      // mini schema 가 해당 path 를 표시하지 않으면 테스트 자체를 스킵하고
      // 구현자가 실스키마로 변경해서 검증할 것
      console.warn("mini schema did not render spec.replicas; adjust fixture");
    }
  });
});
```

**주의:** SchemaTree 의 정확한 스키마 형식을 모르는 상태에서 fixture 를 완전히 작성하기 어렵다. 구현자는 현재 SchemaTree 의 `schema` prop 실제 shape 를 확인 후 미니 스키마를 작성할 것. 구현 정확성은 **브라우저 스모크 + step 6** 로 최종 확인.

- [ ] **Step 5: 호출 측 (`/templates/new/page.tsx`, `/templates/[name]/versions/[v]/edit/page.tsx`) 에서 `fields` prop 전달**

현재 두 페이지가 `EditedResource[]` 또는 `UIModeTemplate` state 를 들고 있으므로, 선택된 리소스의 `fields` map 을 SchemaTree 로 내린다:
```tsx
<SchemaTree
  schema={selectedResourceSchema}
  selectedPath={active?.path ?? null}
  onSelect={(p) => setActive({ resIdx, path: p })}
  fields={selectedResource.fields}
/>
```

- [ ] **Step 6: 빌드·린트 + 브라우저 스모크**

Run: `cd frontend && pnpm test && pnpm lint && pnpm build`

브라우저: 기존 에디터에서 필드를 "사용자 노출" 로 토글하면 트리 우측에 "● exposed" 배지가 나타나는지.

- [ ] **Step 7: 커밋**

```bash
git add frontend/components/SchemaTree.tsx frontend/components/SchemaTree.test.tsx \
  frontend/app/templates/new/page.tsx frontend/app/templates/[name]/versions/[v]/edit/page.tsx
git commit -m "feat(frontend): SchemaTree shows fixed/exposed badges per field mode"
```

---

### Task 3: `FieldInspector` — enum values 리스트 편집기 추가

**Files:**
- Modify: `frontend/components/FieldInspector.tsx`

현재 FieldInspector 는 type=enum 을 처리하긴 하지만 values 입력 UI 가 없다 (스펙 §3.3 에 "enum 선택 시 values 입력용 Input 리스트"). 추가.

- [ ] **Step 1: 현재 FieldInspector 의 type 선택 분기 위치 확인**

Run: `grep -n "enum" frontend/components/FieldInspector.tsx`

- [ ] **Step 2: type === "enum" 일 때 values 리스트 편집 영역 추가**

mode === "exposed" 탭 내부, type Select 아래에:

```tsx
{value.uiSpec?.type === "enum" && (
  <div className="flex flex-col gap-1">
    <label className="text-xs text-slate-600">Values</label>
    {(value.uiSpec.values ?? []).map((v: string, idx: number) => (
      <div key={idx} className="flex items-center gap-1">
        <Input
          value={v}
          onChange={(e) => {
            const next = [...(value.uiSpec!.values ?? [])];
            next[idx] = e.target.value;
            onChange({ ...value, uiSpec: { ...value.uiSpec!, values: next } });
          }}
        />
        <button
          type="button"
          className="text-xs text-red-700 hover:underline"
          onClick={() => {
            const next = [...(value.uiSpec!.values ?? [])].filter((_, i) => i !== idx);
            onChange({ ...value, uiSpec: { ...value.uiSpec!, values: next } });
          }}
        >
          삭제
        </button>
      </div>
    ))}
    <button
      type="button"
      className="self-start text-xs text-blue-700 hover:underline"
      onClick={() => {
        const next = [...(value.uiSpec!.values ?? []), ""];
        onChange({ ...value, uiSpec: { ...value.uiSpec!, values: next } });
      }}
    >
      + 값 추가
    </button>
  </div>
)}
```

타입은 실제 파일의 `value` 변수 타입에 맞출 것.

- [ ] **Step 3: 빌드 + 브라우저 스모크**

Run: `cd frontend && pnpm lint && pnpm build`

브라우저: 필드를 노출 → type=enum 선택 → Values 아래 "+ 값 추가" 클릭 → 3개 입력 → YamlPreview 에 반영되는지.

- [ ] **Step 4: 커밋**

```bash
git add frontend/components/FieldInspector.tsx
git commit -m "feat(frontend): FieldInspector adds enum values list editor"
```

---

### Task 4: `components/editor/EditorLayout.tsx` — ResizablePanelGroup 3-pane

**Files:**
- Create: `frontend/components/editor/EditorLayout.tsx`
- Create: `frontend/components/editor/EditorLayout.test.tsx`

스펙 §3.2 — 3-pane resizable (SchemaTree · FieldInspector · YamlPreview). 각 pane 은 최소 220px.

- [ ] **Step 1: 구현 — `frontend/components/editor/EditorLayout.tsx`**

```tsx
"use client";

import { ResizablePanel, ResizablePanelGroup, ResizableHandle } from "@/components/ui/resizable";

type Props = {
  tree: React.ReactNode;
  inspector: React.ReactNode;
  preview: React.ReactNode;
};

export function EditorLayout({ tree, inspector, preview }: Props) {
  return (
    <ResizablePanelGroup direction="horizontal" className="min-h-[calc(100vh-220px)] rounded-md border">
      <ResizablePanel defaultSize={25} minSize={18}>
        <div className="h-full overflow-auto p-3">{tree}</div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={35} minSize={20}>
        <div className="h-full overflow-auto p-3">{inspector}</div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={40} minSize={25}>
        <div className="h-full overflow-auto">{preview}</div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
```

주의: `minSize` 는 `ResizablePanelGroup` 의 percentage 단위. "220px 최소" 를 퍼센트로 변환하려면 컨테이너 너비 관찰이 필요 — MVP 로 percentage 근사로 시작, 필요 시 후속.

- [ ] **Step 2: 스모크 테스트 (mount-only)**

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { EditorLayout } from "./EditorLayout";

describe("EditorLayout", () => {
  it("mounts all three panels", () => {
    const { container } = render(<EditorLayout tree={<div>T</div>} inspector={<div>I</div>} preview={<div>P</div>} />);
    expect(container.textContent).toContain("T");
    expect(container.textContent).toContain("I");
    expect(container.textContent).toContain("P");
  });
});
```

- [ ] **Step 3: 빌드·테스트 통과**

Run: `cd frontend && pnpm test components/editor/EditorLayout.test.tsx && pnpm lint && pnpm build`
Expected: 통과.

- [ ] **Step 4: 커밋**

```bash
git add frontend/components/editor/EditorLayout.tsx frontend/components/editor/EditorLayout.test.tsx
git commit -m "feat(frontend): EditorLayout wraps 3 panes in ResizablePanelGroup"
```

---

### Task 5: `components/editor/MetaRow.tsx` — 상단 메타 편집 줄

**Files:**
- Create: `frontend/components/editor/MetaRow.tsx`

스펙 §3.2 — name · team · tags 수평 배치.

- [ ] **Step 1: 구현**

```tsx
"use client";

import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";

type TemplateMeta = {
  name: string;
  display_name?: string;
  team?: string | null;
  tags: string[];
};

type Props = {
  meta: TemplateMeta;
  onChange: (m: TemplateMeta) => void;
  nameLocked?: boolean;
};

export function MetaRow({ meta, onChange, nameLocked }: Props) {
  const [tagInput, setTagInput] = useState("");

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border bg-slate-50 px-4 py-2">
      <label className="flex items-center gap-2 text-xs">
        <span className="text-slate-600">이름</span>
        <Input
          className="w-48 text-sm"
          value={meta.name}
          disabled={nameLocked}
          onChange={(e) => onChange({ ...meta, name: e.target.value })}
        />
      </label>
      <label className="flex items-center gap-2 text-xs">
        <span className="text-slate-600">팀</span>
        <Input
          className="w-32 text-sm"
          value={meta.team ?? ""}
          onChange={(e) => onChange({ ...meta, team: e.target.value })}
        />
      </label>
      <div className="flex flex-wrap items-center gap-1">
        {meta.tags.map((t) => (
          <Badge key={t} variant="secondary" className="text-[10px]">
            {t}
            <button
              className="ml-1 opacity-60 hover:opacity-100"
              onClick={() => onChange({ ...meta, tags: meta.tags.filter((x) => x !== t) })}
            >
              ×
            </button>
          </Badge>
        ))}
        <Input
          placeholder="태그 추가"
          className="h-7 w-28 text-xs"
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && tagInput.trim()) {
              e.preventDefault();
              if (!meta.tags.includes(tagInput.trim())) {
                onChange({ ...meta, tags: [...meta.tags, tagInput.trim()] });
              }
              setTagInput("");
            }
          }}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 빌드 확인**

Run: `cd frontend && pnpm lint && pnpm build`

- [ ] **Step 3: 커밋**

```bash
git add frontend/components/editor/MetaRow.tsx
git commit -m "feat(frontend): MetaRow — name/team/tags editor for template"
```

---

### Task 6: `components/editor/BottomBar.tsx` — 저장/퍼블리시 액션 바

**Files:**
- Create: `frontend/components/editor/BottomBar.tsx`

스펙 §3.2 — 미리보기(YamlPreview 쪽 이미 보이므로 toggle 은 생략 가능) · Draft 저장 · Publish. 하단 sticky.

- [ ] **Step 1: 구현**

```tsx
"use client";

import { Button } from "@/components/ui/button";

type Props = {
  canSave: boolean;
  canPublish: boolean;
  saving?: boolean;
  publishing?: boolean;
  onSave: () => void;
  onPublish: () => void;
};

export function BottomBar({ canSave, canPublish, saving, publishing, onSave, onPublish }: Props) {
  return (
    <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t bg-white/90 px-4 py-3 backdrop-blur">
      <Button
        variant="outline"
        onClick={onSave}
        disabled={!canSave || saving}
      >
        {saving ? "저장 중…" : "Draft 저장"}
      </Button>
      <Button
        onClick={onPublish}
        disabled={!canPublish || publishing}
      >
        {publishing ? "퍼블리시 중…" : "Publish"}
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: 커밋**

```bash
git add frontend/components/editor/BottomBar.tsx
git commit -m "feat(frontend): BottomBar — sticky save + publish actions"
```

---

### Task 7: `/templates/new/page.tsx` 재배치 — EditorLayout + MetaRow + BottomBar + ?mode=ui 분기

**Files:**
- Modify: `frontend/app/templates/new/page.tsx`

현재 page.tsx 는 인라인 grid 로 3 pane 을 구성하고 저장 버튼이 중간에 있음. 이를 재배치:
1. 상단에 `<MetaRow>`
2. 중간에 `<EditorLayout tree={<SchemaTree>} inspector={<FieldInspector>} preview={<YamlPreview>} />`
3. 하단 sticky `<BottomBar>`
4. `searchParams?.mode === "yaml"` 일 때는 기존 YAML 에디터 (YamlEditor 컴포넌트 사용) 로 fallback render.

- [ ] **Step 1: 현재 page.tsx 읽고 state 변수 파악**

Run: `cat frontend/app/templates/new/page.tsx`

- [ ] **Step 2: 재작성 (client component 로 분리)**

현재 page 가 client 이면 그대로, server 이면 client 로 전환하거나 별도 client 컴포넌트로 추출. 스펙 §3.1:

```tsx
"use client";

import { useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { EditorLayout } from "@/components/editor/EditorLayout";
import { MetaRow } from "@/components/editor/MetaRow";
import { BottomBar } from "@/components/editor/BottomBar";
import { SchemaTree } from "@/components/SchemaTree";
import { FieldInspector } from "@/components/FieldInspector";
import { YamlPreview } from "@/components/YamlPreview";
import { KindPicker } from "@/components/KindPicker";
// 기존 YAML 모드 fallback 용:
import { YamlEditor } from "@/components/YamlEditor";
// 기존 state 타입 import (구현 파일 그대로 참조)

export default function NewTemplatePage() {
  const params = useSearchParams();
  const mode = params.get("mode") ?? "ui";
  const router = useRouter();

  if (mode === "yaml") {
    return <YamlEditor /* 기존 props 그대로 */ />;
  }

  // --- 기존 UI 모드 state 블록 그대로 유지 ---
  // const [resources, setResources] = useState<EditedResource[]>([]);
  // const [active, setActive] = useState<{ resIdx: number; path: string } | null>(null);
  // const [meta, setMeta] = useState<TemplateMeta>({ name: "", tags: [] });
  // … (현재 구현 복사 + MetaRow 에 연결)

  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);

  async function onSaveDraft() { /* 기존 저장 로직 호출 */ }
  async function onPublish() { /* 기존 로직 또는 새로: save → publish */ }

  return (
    <div className="flex min-h-[calc(100vh-110px)] flex-col gap-3">
      <MetaRow meta={meta} onChange={setMeta} />
      <KindPicker /* 기존 props */ />
      <EditorLayout
        tree={
          <SchemaTree
            schema={activeResourceSchema}
            selectedPath={active?.path ?? null}
            onSelect={(p) => setActive({ resIdx: active?.resIdx ?? 0, path: p })}
            fields={activeResource?.fields}
          />
        }
        inspector={
          active ? (
            <FieldInspector
              path={active.path}
              node={activeResourceSchema?.[active.path]}
              value={activeResource?.fields?.[active.path]}
              onChange={(v) => /* 기존 update 로직 */}
              onClear={() => /* 기존 clear 로직 */}
            />
          ) : (
            <p className="text-sm text-slate-500">트리에서 필드를 선택하세요.</p>
          )
        }
        preview={<YamlPreview uiState={{ resources }} />}
      />
      <BottomBar
        canSave={meta.name.length > 0 && resources.length > 0}
        canPublish={/* resources 가 검증된 상태 */ true}
        saving={saving}
        publishing={publishing}
        onSave={onSaveDraft}
        onPublish={onPublish}
      />
    </div>
  );
}
```

**중요:** 이 Task 는 **기존 state/로직을 유지**하고 레이아웃 껍데기만 교체한다. 기능 유지가 우선.

- [ ] **Step 3: `/templates/[name]/versions/[v]/edit/page.tsx` 에도 같은 재배치 적용**

같은 패턴 (초기 state 가 버전 fetch 결과로 채워지는 것만 다름).

- [ ] **Step 4: 빌드·테스트·린트 통과**

Run: `cd frontend && pnpm test && pnpm lint && pnpm build`

- [ ] **Step 5: 브라우저 스모크**

- `/templates/new` → MetaRow → 3-pane resizable → 하단 sticky bar
- `/templates/new?mode=yaml` → 기존 YamlEditor fallback
- 필드 클릭 → FieldInspector 활성, YamlPreview 300ms 후 갱신
- Draft 저장 / Publish 버튼 동작 유지

- [ ] **Step 6: 커밋**

```bash
git add frontend/app/templates/new/page.tsx frontend/app/templates/[name]/versions/[v]/edit/page.tsx
git commit -m "feat(frontend): UI editor uses EditorLayout + MetaRow + BottomBar + mode=yaml fallback"
```

---

### Task 8: 선택 필드 YamlPreview 교차 하이라이트 (optional, 후속 가능)

**Files:**
- Modify: `frontend/components/YamlPreview.tsx`

스펙 §3.6 — "선택된 필드가 트리·인스펙터·YAML 세 곳에 동시 하이라이트". 현재 YAML 은 선택된 path 를 강조하지 않는다.

이 단계는 **난이도가 높고** (Monaco editor API + YAML path → line number 매핑), MVP 범위에선 다음 기능만:
- 선택된 path 에 해당하는 YAML 내 첫 등장 라인으로 **스크롤**
- 해당 라인에 `monaco.editor.IModelDeltaDecoration` 으로 background `bg-blue-50` 유사 강조

복잡도 때문에 이 태스크는 **optional**, Plan 4 의 Acceptance 에서 제외. 별도 후속 플랜으로 뺄 수 있음.

스킵하려면 이 태스크 자체를 생략하고 Task 9 로 진행. 구현하려면 다음 스텝:

- [ ] **Step 1: `YamlPreview` 에 `selectedPath?: string` prop 추가**
- [ ] **Step 2: Monaco 의 `editor.revealLineInCenter` + `deltaDecorations` 사용**
- [ ] **Step 3: 빌드·브라우저 스모크**
- [ ] **Step 4: 커밋**

---

### Task 9: Acceptance 검증 및 마무리

- [ ] **Step 1: 전체 테스트·빌드 통과**

Run: `cd frontend && pnpm test && pnpm lint && pnpm build`
Run: `cd backend && go test ./...`

- [ ] **Step 2: 스펙 §3.6 Acceptance 체크리스트 수동 확인**

- [ ] User 롤로 `/templates/new` 진입 시 서버 403 + RoleBadge (이 부분은 Plan 0 의 TopBar 에 이미 있음 — 서버 가드는 `backend/internal/api/permissions.go` 의 기존 admin guard 확인)
- [ ] 3 pane 모두 리사이즈 가능, 최소 너비 유지 (퍼센트 근사)
- [ ] 선택된 필드가 트리·인스펙터 두 곳 동시 하이라이트 (Task 2, 3 로 만족). YAML 교차 하이라이트는 Task 8 스킵 시 미충족 (후속).
- [ ] YAML 미리보기 read-only (MonacoPanel `readOnly` prop)
- [ ] Publish 버튼은 검증 통과 시만 enable (기존 검증 로직 재사용)
- [ ] MetaRow (name/team/tags) 변경이 draft 저장에 포함

- [ ] **Step 3: 브라우저 E2E 스모크**

- 새 UI 모드 템플릿 생성: MetaRow 채움 → KindPicker 로 Deployment 추가 → 트리에서 `spec.replicas` 클릭 → 인스펙터 "사용자 노출" → type=integer, min=1, max=5 → YamlPreview 에 ui-spec 반영 → Draft 저장 → Publish
- 기존 published 템플릿 수정: `/templates/<name>/versions/2/edit` 로 이동 → 기존 상태 로드 → MetaRow 에서 tags 추가 → Draft 저장 성공

- [ ] **Step 4: (선택) Screenshot 보관**

Playwright MCP 로 `browser_take_screenshot` → `docs/superpowers/specs/assets/2026-04-19-admin-editor-redesign.png` 저장 + 스펙 문서에 링크 (v0.2 개정 대상, 본 플랜에서는 미포함).

- [ ] **Step 5: 최종 커밋**

이 태스크 자체가 산출물이 없으면 비어있는 상태로 커밋하지 않는다 — 위 모든 태스크가 이미 독립 커밋됨.

---

## 검증 (End-to-end)

1. **빌드·테스트·린트**:
   ```bash
   cd frontend && pnpm test && pnpm lint && pnpm build
   cd backend && go test ./...
   ```

2. **브라우저 스모크 (최종)**:
   - `/templates/new` (admin 계정) — MetaRow, ResizablePanelGroup, BottomBar 모두 노출, `?mode=yaml` 로 YamlEditor fallback 동작
   - 기존 draft 편집 (`/templates/<name>/versions/<v>/edit`) 도 동일 레이아웃
   - SchemaTree 에 exposed 배지 (blue) / fixed 배지 (gray) 분간
   - FieldInspector 에서 type=enum 선택 시 Values 리스트 편집 가능
   - YamlPreview 가 use-debounce 로 300ms 갱신
   - Draft 저장, Publish 정상 동작

3. **리그레션**:
   - `/releases/<id>` (Plan 2), `/catalog` (Plan 1), `/catalog/<t>/deploy` (Plan 3) 모두 동작
   - TopBar 네비게이션 role 별 (Plan 0) 동작

---

## 스코프 밖 (후속)

- 선택 필드 YAML 교차 하이라이트 (Task 8) — 별도 플랜
- 스크린샷 기반 시각 회귀 테스트 (Playwright visual regression) — 별도 플랜
- MetaRow 의 team autocomplete (현재는 free text) — v1.1
- ResizablePanelGroup 의 "220px 최소" 정확 구현 (현재 percent 근사) — 사용자 피드백 기반 개선
