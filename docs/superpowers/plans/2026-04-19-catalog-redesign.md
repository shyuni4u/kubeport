# Catalog Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/catalog` 화면을 스펙 §4 에 맞춰 재설계한다 — 검색 Input · 태그 필터 (ToggleGroup) · CatalogCard (아이콘 + 설명 line-clamp + 태그 배지) · 빈 상태 UI · 아이콘 매핑 테이블.

**Architecture:** 현재 server component 는 그대로 데이터 페치 후, 필터링·검색은 **client component** 로 분리한다 (사용자 입력 반응 필요). TemplateCard.tsx 는 unused 이므로 삭제·대체하고 새 `CatalogCard.tsx` 를 만든다. 아이콘 매핑은 `lib/template-icons.ts` 로 분리.

**Tech Stack:** 기존 + Plan 0 산출물 (`RoleBadge` 참조만, `Badge`/`ToggleGroup`/`Input` 사용), `lucide-react` 아이콘, TanStack Query 는 **쓰지 않음** (첫 로드는 서버에서, 이후 필터는 클라 상태로 충분).

> **Base UI vs Radix (중요)** — `components/ui/toggle-group.tsx` 는 `@base-ui/react/toggle-group` 를 래핑한다 (Radix 가 아님). API 차이:
> - `value`: `readonly string[]` (배열, not 단일 string)
> - `onValueChange`: `(groupValue: string[], ...) => void`
> - `type="single"` prop 없음 — 대신 `multiple` boolean (default `false` = single)
>
> 따라서 single-select 패턴: `value={tag ? [tag] : []}` / `onValueChange={(v) => setTag(v[0] ?? "")}`. Plan 2-4 에서도 동일 규칙 적용.

**스펙 참조:** [2026-04-19-frontend-design-spec.md](../specs/2026-04-19-frontend-design-spec.md) §4.

**전제:** Plan 0 (foundation) 이 완료되어 있어야 한다 (shadcn ToggleGroup · Input · Badge, Vitest 인프라, RoleBadge·StatusChip).

---

### Task 1: `lib/template-icons.ts` — 태그 기반 아이콘 매핑

**Files:**
- Create: `frontend/lib/template-icons.ts`
- Create: `frontend/lib/template-icons.test.ts`

스펙 §4.5. 템플릿의 `tags[0]` 또는 `metadata.icon` 으로 아이콘을 고른다. lucide-react 아이콘 이름을 문자열로 리턴하지 말고 **LucideIcon 컴포넌트 자체**를 리턴 (타입 안전). 매핑에 없으면 fallback.

- [ ] **Step 1: 실패 테스트 — `frontend/lib/template-icons.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { iconFor } from "./template-icons";
import { Box, Database, Globe, Server } from "lucide-react";

describe("iconFor", () => {
  it("returns Globe for 'web' tag", () => {
    expect(iconFor(["web"])).toBe(Globe);
  });
  it("returns Database for 'database' tag", () => {
    expect(iconFor(["database"])).toBe(Database);
  });
  it("returns Server for 'backend' tag", () => {
    expect(iconFor(["backend"])).toBe(Server);
  });
  it("prefers first matching tag when multiple", () => {
    expect(iconFor(["unknown", "web"])).toBe(Globe);
  });
  it("returns fallback Box when no tag matches", () => {
    expect(iconFor(["unknown"])).toBe(Box);
  });
  it("returns fallback Box on empty/undefined tags", () => {
    expect(iconFor([])).toBe(Box);
    expect(iconFor(undefined)).toBe(Box);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && pnpm test lib/template-icons.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현 — `frontend/lib/template-icons.ts`**

```ts
import { Box, Database, Globe, Server, type LucideIcon } from "lucide-react";

const MAP: Record<string, LucideIcon> = {
  web: Globe,
  frontend: Globe,
  database: Database,
  db: Database,
  backend: Server,
  api: Server,
};

export function iconFor(tags: readonly string[] | undefined | null): LucideIcon {
  if (!tags) return Box;
  for (const t of tags) {
    const hit = MAP[t.toLowerCase()];
    if (hit) return hit;
  }
  return Box;
}
```

- [ ] **Step 4: 통과 확인 + 빌드**

Run: `cd frontend && pnpm test lib/template-icons.test.ts && pnpm lint && pnpm build`
Expected: `6 passed`, 빌드 OK.

- [ ] **Step 5: 커밋**

```bash
git add frontend/lib/template-icons.ts frontend/lib/template-icons.test.ts
git commit -m "feat(frontend): add template icon mapping (tags → LucideIcon)"
```

---

### Task 2: `components/CatalogCard.tsx` — 신규 카드 컴포넌트

**Files:**
- Create: `frontend/components/CatalogCard.tsx`
- Create: `frontend/components/CatalogCard.test.tsx`
- Delete (Task 5 에서 수행): `frontend/components/TemplateCard.tsx`

스펙 §4.3. 아이콘 · 타이틀 · 설명 (line-clamp-2 + min-h-9) · 태그 배지 · "v{version} · {team}" · 링크.

- [ ] **Step 1: 실패 테스트 — `frontend/components/CatalogCard.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CatalogCard, type CatalogCardTemplate } from "./CatalogCard";

const base: CatalogCardTemplate = {
  name: "web-service",
  display_name: "Web Service",
  description: "간단한 웹 서비스 배포 템플릿",
  tags: ["web"],
  current_version: 2,
  owning_team_name: "platform",
};

describe("CatalogCard", () => {
  it("renders display_name, description, version, team", () => {
    render(<CatalogCard template={base} />);
    expect(screen.getByText("Web Service")).toBeInTheDocument();
    expect(screen.getByText("간단한 웹 서비스 배포 템플릿")).toBeInTheDocument();
    expect(screen.getByText(/v2/)).toBeInTheDocument();
    expect(screen.getByText(/platform/)).toBeInTheDocument();
  });

  it("renders tag badges", () => {
    render(<CatalogCard template={{ ...base, tags: ["web", "public"] }} />);
    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.getByText("public")).toBeInTheDocument();
  });

  it("links to /catalog/{name}/deploy", () => {
    render(<CatalogCard template={base} />);
    const link = screen.getByRole("link", { name: /배포하기/ });
    expect(link).toHaveAttribute("href", "/catalog/web-service/deploy");
  });

  it("falls back gracefully when description is null", () => {
    render(<CatalogCard template={{ ...base, description: null }} />);
    // min-height placeholder should still exist (empty paragraph)
    expect(screen.getByText("Web Service")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && pnpm test components/CatalogCard.test.tsx`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현 — `frontend/components/CatalogCard.tsx`**

```tsx
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { iconFor } from "@/lib/template-icons";

export type CatalogCardTemplate = {
  name: string;
  display_name: string;
  description: string | null;
  tags: string[];
  current_version: number;
  owning_team_name?: string | null;
};

type Props = { template: CatalogCardTemplate };

export function CatalogCard({ template }: Props) {
  const Icon = iconFor(template.tags);
  const teamLabel = template.owning_team_name ?? "—";
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-white p-4 shadow-sm hover:shadow transition">
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-blue-50 text-blue-700">
          <Icon className="h-4 w-4" />
        </span>
        <h3 className="text-sm font-medium">{template.display_name}</h3>
      </div>
      <p className="text-xs text-slate-600 line-clamp-2 min-h-9">
        {template.description ?? ""}
      </p>
      <div className="flex flex-wrap gap-1">
        {template.tags.map((t) => (
          <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>
        ))}
      </div>
      <div className="mt-auto flex items-center justify-between text-xs text-slate-500">
        <span>v{template.current_version} · {teamLabel}</span>
        <Link
          href={`/catalog/${template.name}/deploy`}
          className="text-blue-700 hover:underline"
        >
          배포하기 →
        </Link>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 통과 + 빌드**

Run: `cd frontend && pnpm test components/CatalogCard.test.tsx && pnpm lint && pnpm build`
Expected: `4 passed`.

- [ ] **Step 5: 커밋**

```bash
git add frontend/components/CatalogCard.tsx frontend/components/CatalogCard.test.tsx
git commit -m "feat(frontend): add CatalogCard with icon, description clamp, tag badges"
```

---

### Task 3: `components/CatalogBrowser.tsx` — 검색 + 태그 필터 (client component)

**Files:**
- Create: `frontend/components/CatalogBrowser.tsx`
- Create: `frontend/components/CatalogBrowser.test.tsx`

스펙 §4.2 레이아웃 + §4.4 클라 측 필터. 서버 컴포넌트 `page.tsx` 가 전체 템플릿 배열을 prop 으로 넘기면, 이 컴포넌트가 검색/태그 상태를 관리하고 `CatalogCard` 그리드를 렌더. 빈 상태 UI (§4.5) 포함.

- [ ] **Step 1: 실패 테스트 — `frontend/components/CatalogBrowser.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CatalogBrowser } from "./CatalogBrowser";

const sample = [
  { name: "web", display_name: "Web Service", description: "웹 배포", tags: ["web", "public"], current_version: 2, owning_team_name: "platform" },
  { name: "db", display_name: "Database", description: "PostgreSQL", tags: ["database"], current_version: 1, owning_team_name: "data" },
  { name: "api", display_name: "API Gateway", description: "내부 API", tags: ["backend"], current_version: 3, owning_team_name: "platform" },
];

describe("CatalogBrowser", () => {
  it("renders all templates initially", () => {
    render(<CatalogBrowser templates={sample} />);
    expect(screen.getByText("Web Service")).toBeInTheDocument();
    expect(screen.getByText("Database")).toBeInTheDocument();
    expect(screen.getByText("API Gateway")).toBeInTheDocument();
  });

  it("filters by search (matches display_name)", async () => {
    render(<CatalogBrowser templates={sample} />);
    const search = screen.getByPlaceholderText(/검색/);
    await userEvent.type(search, "API");
    expect(screen.queryByText("Web Service")).not.toBeInTheDocument();
    expect(screen.getByText("API Gateway")).toBeInTheDocument();
  });

  it("filters by search (matches description)", async () => {
    render(<CatalogBrowser templates={sample} />);
    await userEvent.type(screen.getByPlaceholderText(/검색/), "PostgreSQL");
    expect(screen.getByText("Database")).toBeInTheDocument();
    expect(screen.queryByText("Web Service")).not.toBeInTheDocument();
  });

  it("filters by tag (AND with search)", async () => {
    render(<CatalogBrowser templates={sample} />);
    const webTag = screen.getByRole("button", { name: "web" });
    await userEvent.click(webTag);
    expect(screen.getByText("Web Service")).toBeInTheDocument();
    expect(screen.queryByText("Database")).not.toBeInTheDocument();
  });

  it("shows empty state when no matches", async () => {
    render(<CatalogBrowser templates={sample} />);
    await userEvent.type(screen.getByPlaceholderText(/검색/), "xyzNoMatch");
    expect(screen.getByText(/일치하는 템플릿이 없습니다/)).toBeInTheDocument();
  });

  it("shows admin-empty state when templates array is empty", () => {
    render(<CatalogBrowser templates={[]} />);
    expect(screen.getByText(/관리자가 아직 템플릿을 만들지 않았습니다/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && pnpm test components/CatalogBrowser.test.tsx`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현 — `frontend/components/CatalogBrowser.tsx`**

```tsx
"use client";

import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { CatalogCard, type CatalogCardTemplate } from "./CatalogCard";

type Props = { templates: CatalogCardTemplate[] };

export function CatalogBrowser({ templates }: Props) {
  const [q, setQ] = useState("");
  const [tag, setTag] = useState<string>("");

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const t of templates) for (const tag of t.tags) set.add(tag);
    return Array.from(set).sort();
  }, [templates]);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return templates.filter((t) => {
      if (tag && !t.tags.includes(tag)) return false;
      if (ql) {
        const hay = (t.display_name + " " + (t.description ?? "")).toLowerCase();
        if (!hay.includes(ql)) return false;
      }
      return true;
    });
  }, [templates, q, tag]);

  if (templates.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-slate-500">
        <p className="text-sm">관리자가 아직 템플릿을 만들지 않았습니다.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">카탈로그</h1>
        <Input
          className="max-w-xs"
          placeholder="템플릿 검색…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {allTags.length > 0 && (
        <ToggleGroup
          value={tag ? [tag] : []}
          onValueChange={(v) => setTag(v[0] ?? "")}
          className="flex-wrap justify-start"
        >
          {allTags.map((t) => (
            <ToggleGroupItem key={t} value={t}>{t}</ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
      {/* Note: Base UI ToggleGroup — value is string[], no "전체" reset item.
          Users clear the filter by re-clicking the active tag. */}
      {filtered.length === 0 ? (
        <div className="py-12 text-center text-sm text-slate-500">
          일치하는 템플릿이 없습니다. 검색어나 태그 필터를 바꿔보세요.
        </div>
      ) : (
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}
        >
          {filtered.map((t) => (
            <CatalogCard key={t.name} template={t} />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 통과 + 빌드**

Run: `cd frontend && pnpm test components/CatalogBrowser.test.tsx && pnpm lint && pnpm build`
Expected: `6 passed`.

- [ ] **Step 5: 커밋**

```bash
git add frontend/components/CatalogBrowser.tsx frontend/components/CatalogBrowser.test.tsx
git commit -m "feat(frontend): CatalogBrowser with search + tag filter + empty states"
```

---

### Task 4: `app/catalog/page.tsx` 리디자인 — Server component 가 CatalogBrowser 에 위임

**Files:**
- Modify: `frontend/app/catalog/page.tsx`

현재 page.tsx 는 직접 필터링하고 인라인 카드를 렌더한다. 이를 "데이터 페치 + published 필터" 만 하고 결과를 `CatalogBrowser` 에 전달하는 형태로 바꾼다.

- [ ] **Step 1: 현재 page.tsx 구조 확인**

Run: `cat frontend/app/catalog/page.tsx`
Expected: server component, `apiFetch("/v1/templates")` 호출, status!=="deprecated" 로 필터, 인라인 3-col grid 렌더.

- [ ] **Step 2: `frontend/app/catalog/page.tsx` 재작성**

```tsx
import { apiFetch } from "@/lib/api-server";
import { CatalogBrowser } from "@/components/CatalogBrowser";
import type { CatalogCardTemplate } from "@/components/CatalogCard";

type ApiTemplate = CatalogCardTemplate & {
  current_status: string | null;
};

export default async function CatalogPage() {
  const data = await apiFetch("/v1/templates")
    .then((r) => (r.ok ? r.json() : { templates: [] }))
    .catch(() => ({ templates: [] }));

  const templates: CatalogCardTemplate[] = (data.templates as ApiTemplate[])
    .filter((t) => t.current_status === "published")
    .map(({ current_status: _, ...rest }) => rest);

  return <CatalogBrowser templates={templates} />;
}
```

주의: 서버 `ListTemplates` 가 이미 deprecated 를 숨길 수 있다면(memory 에 `feat: ListTemplates returns current_status; catalog hides deprecated templates` 커밋 기록), 이 클라이언트측 필터는 중복 방어가 된다. 서버 동작이 바뀌더라도 `published` 만 남도록 명시.

- [ ] **Step 3: 빌드·린트 + 기존 테스트 모두 통과**

Run: `cd frontend && pnpm test && pnpm lint && pnpm build`
Expected: 모두 통과.

- [ ] **Step 4: 브라우저 스모크**

Run: `cd frontend && pnpm dev` (백그라운드)
브라우저 `/catalog` 열기:
- 상단 "카탈로그" + 검색 Input 우측
- 태그 ToggleGroup ("전체" + 태그들) 아래 줄
- CatalogCard 그리드 (`auto-fit, minmax(190px, 1fr)`)
- 검색어 입력 시 필터링
- 태그 클릭 시 필터링
- 해당 템플릿이 없는 검색어 입력 → "일치하는 템플릿이 없습니다"

Playwright MCP: `browser_navigate("http://localhost:3000/catalog")` → `browser_snapshot`.

- [ ] **Step 5: 커밋**

```bash
git add frontend/app/catalog/page.tsx
git commit -m "feat(frontend): /catalog delegates to CatalogBrowser (search + filter)"
```

---

### Task 5: 미사용 `TemplateCard.tsx` 삭제

**Files:**
- Delete: `frontend/components/TemplateCard.tsx`

기존 page.tsx 가 인라인 카드를 썼으므로 TemplateCard 는 아무도 import 하지 않는다. Task 4 이후 확실히 dead code.

- [ ] **Step 1: 레퍼런스 잔존 확인**

Run: `grep -rn TemplateCard frontend`
Expected: `frontend/components/TemplateCard.tsx` 자체만 출력 (다른 사용 없음).

- [ ] **Step 2: 파일 삭제**

Run: `rm frontend/components/TemplateCard.tsx`

- [ ] **Step 3: 빌드 확인**

Run: `cd frontend && pnpm build && pnpm lint`
Expected: 통과.

- [ ] **Step 4: 커밋**

```bash
git add frontend/components/TemplateCard.tsx
git commit -m "chore(frontend): remove unused TemplateCard (superseded by CatalogCard)"
```

---

## 검증 (End-to-end)

Plan 1 완료 시점에 다음이 모두 만족되어야 한다:

1. **테스트·빌드·린트 올 그린** — `cd frontend && pnpm test && pnpm lint && pnpm build`. 추가 테스트 ≥ 16 개 (icons 6 + CatalogCard 4 + CatalogBrowser 6).

2. **브라우저 스모크**:
   - `/catalog` 가 새 레이아웃으로 렌더 (검색 + 태그 + auto-fit 그리드)
   - 검색은 display_name + description 에서 AND 일치
   - 태그 필터 단일 선택, "전체" 로 리셋
   - 템플릿 0개 시 "관리자가 아직 템플릿을 만들지 않았습니다"
   - 일치 0건 시 "일치하는 템플릿이 없습니다"

3. **Dead code 정리**:
   - `grep -rn TemplateCard frontend` → 출력 없음
   - `frontend/components/TemplateCard.tsx` 없음

4. **리그레션 없음**:
   - `/releases`, `/templates`, `/admin/teams` 등 다른 페이지는 건드리지 않음
   - Plan 0 산출물(RoleBadge 등) 여전히 잘 동작

---

## 다음 단계

- **Plan 2** (릴리스 상세 리디자인) — 중첩 라우트 + 탭 + SSE 로그
- **Plan 3** (배포 폼 리디자인) — schemaFromUISpec + RBAC 패널 + 업데이트 플로우
- **Plan 4** (Admin UI 에디터 리디자인) — Resizable 3-pane + 선택 하이라이트 확장
