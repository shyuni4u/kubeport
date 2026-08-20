# Frontend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 4개 화면 리디자인의 전제가 되는 공통 기반을 구축한다 — 누락 패키지·shadcn 컴포넌트 설치, 테스트 인프라 도입, 공통 UI 토큰 (RoleBadge, StatusChip, 확장된 Badge variants), AppShell (TopBar) 재편, TanStack Query Provider, Zustand 스토어 스캐폴드.

**Architecture:** 기존 플랫 컴포넌트 배치(`frontend/components/*.tsx`)를 유지한다. 이 플랜은 새 라우트를 만들지 않는다. 최종 상태에서 홈화면을 브라우저로 열면 RoleBadge 가 상단 바에 보이고 로그아웃 드롭다운이 동작해야 한다. 이후 Plan 1-4 (카탈로그 / 릴리스 상세 / 배포 폼 / Admin 에디터) 가 이 기반 위에서 각각 독립 PR 로 진행될 수 있어야 한다.

**Tech Stack:** Next.js 16.2.4 (App Router) · React 19 · Tailwind v4 (`@theme inline` in `app/globals.css`) · shadcn v4 / Base UI (`"style": "base-nova"`) · TypeScript strict · Vitest + React Testing Library + jsdom (이 플랜에서 도입) · TanStack Query v5 · Zustand v5 · `use-debounce`.

**스펙 참조:** [docs/superpowers/specs/2026-04-19-frontend-design-spec.md](../specs/2026-04-19-frontend-design-spec.md) §1, §2, §7.

**사전 확인 사항** (Task 시작 전 1회):
- 작업 디렉터리는 이 플랜이 있는 워크트리 `.worktrees/docs-frontend-design-spec/` 이거나, 이 플랜 실행용으로 별도 worktree 를 팔 것. `using-git-worktrees` 스킬 사용.
- `frontend/AGENTS.md` 가 "This is NOT the Next.js you know" 라고 경고한다. Next.js 16 이므로 필요 시 `node_modules/next/dist/docs/` 를 참조. 이 플랜은 라우트/렌더링 API 를 건드리지 않지만, 주의할 것.
- `frontend/components.json` 의 `style` 은 `base-nova` 다. `pnpm dlx shadcn@4 add …` 시 Base UI 기반 컴포넌트가 설치된다. 이건 정상.

---

### Task 1: Missing runtime packages 설치

**Files:**
- Modify: `frontend/package.json`

- [ ] **Step 1: 현재 deps 스냅샷 확인**

Run: `cd frontend && cat package.json | grep -E 'react-query|zustand|use-debounce'`
Expected: 아무것도 출력되지 않음 (세 패키지 모두 없음)

- [ ] **Step 2: 세 패키지 설치**

Run:
```bash
cd frontend && pnpm add @tanstack/react-query@^5 zustand@^5 use-debounce@^10
```
Expected: `package.json` dependencies 에 세 줄 추가됨, `pnpm-lock.yaml` 갱신.

- [ ] **Step 3: 설치 검증**

Run: `cd frontend && pnpm list @tanstack/react-query zustand use-debounce --depth=0`
Expected: 세 패키지 모두 "installed" 로 표시.

- [ ] **Step 4: 빌드 확인**

Run: `cd frontend && pnpm build`
Expected: 기존 빌드 성공 그대로 통과 (새 임포트 없음).

- [ ] **Step 5: 커밋**

```bash
git add frontend/package.json frontend/pnpm-lock.yaml
git commit -m "chore(frontend): add @tanstack/react-query, zustand, use-debounce"
```

---

### Task 2: 누락 shadcn 컴포넌트 일괄 추가

**Files:**
- Create (13 files): `frontend/components/ui/{tabs,toggle-group,resizable,separator,scroll-area,form,slider,checkbox,switch,tooltip,alert-dialog,breadcrumb,dropdown-menu}.tsx`
- Modify: `frontend/package.json` (shadcn add 가 추가할 수 있는 의존성 — 예: `@base-ui/react` 는 이미 있음, 거의 변경 없을 것)

- [ ] **Step 1: 현재 `components/ui/` 내용 확인**

Run: `ls frontend/components/ui/`
Expected: `badge.tsx button.tsx card.tsx dialog.tsx input.tsx select.tsx table.tsx` (7 개).

- [ ] **Step 2: shadcn add 실행**

Run:
```bash
cd frontend && pnpm dlx shadcn@4 add \
  tabs toggle-group resizable separator scroll-area form slider \
  checkbox switch tooltip alert-dialog breadcrumb dropdown-menu
```
Expected: 13 개 파일이 `components/ui/` 에 생성됨. 기존 7개는 덮어쓰지 않음 (이름 겹치지 않음).
주의: `components.json` 의 `style: "base-nova"` 가 base-ui 버전을 고르므로, 각 파일 최상단이 `import { … } from "@base-ui/react/…"` 형태일 것. 정상.

- [ ] **Step 3: 설치 결과 확인**

Run: `ls frontend/components/ui/ | wc -l`
Expected: `20` (기존 7 + 신규 13).

- [ ] **Step 4: 빌드·린트 통과 확인**

Run: `cd frontend && pnpm build && pnpm lint`
Expected: 둘 다 성공. 새로 추가된 파일들은 아직 어디서도 import 되지 않지만, 파일 자체에 타입 에러나 린트 에러가 없어야 함.

- [ ] **Step 5: 커밋**

```bash
git add frontend/components/ui/ frontend/package.json frontend/pnpm-lock.yaml
git commit -m "chore(frontend): add 13 shadcn components (tabs/resizable/form/...)"
```

---

### Task 3: Vitest + React Testing Library 테스트 인프라 도입

**Files:**
- Create: `frontend/vitest.config.ts`
- Create: `frontend/vitest.setup.ts`
- Create: `frontend/tests/smoke.test.ts`
- Modify: `frontend/package.json` (scripts + devDeps)
- Modify: `frontend/tsconfig.json` (types 에 `vitest/globals` 추가)

- [ ] **Step 1: 개발 의존성 설치**

Run:
```bash
cd frontend && pnpm add -D vitest@^2 @vitest/ui @vitejs/plugin-react \
  @testing-library/react @testing-library/jest-dom @testing-library/user-event \
  jsdom
```
Expected: `devDependencies` 에 7 개 항목 추가.

- [ ] **Step 2: `frontend/vitest.config.ts` 작성**

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules", ".next"],
  },
});
```

- [ ] **Step 3: `frontend/vitest.setup.ts` 작성**

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 4: `frontend/package.json` 의 `scripts` 수정**

`"lint": "eslint"` 줄 다음에 추가:
```json
    "test": "vitest run",
    "test:watch": "vitest"
```

- [ ] **Step 5: `frontend/tsconfig.json` 의 `compilerOptions.types` 확장**

기존 `types` 가 없으면 추가, 있으면 병합:
```json
"types": ["vitest/globals", "@testing-library/jest-dom"]
```

- [ ] **Step 6: 스모크 테스트 작성 — `frontend/tests/smoke.test.ts`**

```ts
import { describe, it, expect } from "vitest";

describe("test infra", () => {
  it("runs vitest", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 7: 테스트 실행해서 녹색 확인**

Run: `cd frontend && pnpm test`
Expected: `1 passed`. 실패하면 jsdom / 설정 문제이므로 바로 잡을 것.

- [ ] **Step 8: 빌드 무결성 확인**

Run: `cd frontend && pnpm build && pnpm lint`
Expected: 둘 다 통과 — 테스트 인프라가 프로덕션 번들에 섞이지 않아야 한다.

- [ ] **Step 9: 커밋**

```bash
git add frontend/vitest.config.ts frontend/vitest.setup.ts frontend/tests/smoke.test.ts \
  frontend/package.json frontend/pnpm-lock.yaml frontend/tsconfig.json
git commit -m "chore(frontend): set up Vitest + React Testing Library"
```

---

### Task 4: `lib/role.ts` — 세션 groups 로부터 role 판정

**Files:**
- Create: `frontend/lib/role.ts`
- Create: `frontend/lib/role.test.ts`

스펙 §1.1 에 따르면 `groups` 클레임에 `kubeport-admin` 이 포함된 경우 admin, 아니면 user. 로직은 순수 함수 하나 — TDD 적합.

- [ ] **Step 1: 실패 테스트 작성 — `frontend/lib/role.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { roleFromGroups } from "./role";

describe("roleFromGroups", () => {
  it("returns 'admin' when groups include kubeport-admin", () => {
    expect(roleFromGroups(["kubeport-admin", "dev"])).toBe("admin");
  });

  it("returns 'user' when groups lack kubeport-admin", () => {
    expect(roleFromGroups(["dev", "qa"])).toBe("user");
  });

  it("returns 'user' on null/undefined groups", () => {
    expect(roleFromGroups(null)).toBe("user");
    expect(roleFromGroups(undefined)).toBe("user");
  });

  it("returns 'user' on empty array", () => {
    expect(roleFromGroups([])).toBe("user");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && pnpm test lib/role.test.ts`
Expected: FAIL — `Cannot find module './role'`.

- [ ] **Step 3: 최소 구현 — `frontend/lib/role.ts`**

```ts
export type Role = "admin" | "user";

export const ADMIN_GROUP = "kubeport-admin";

export function roleFromGroups(groups: readonly string[] | null | undefined): Role {
  if (!groups || groups.length === 0) return "user";
  return groups.includes(ADMIN_GROUP) ? "admin" : "user";
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && pnpm test lib/role.test.ts`
Expected: `4 passed`.

- [ ] **Step 5: 타입·린트·빌드 확인**

Run: `cd frontend && pnpm lint && pnpm build`
Expected: 통과.

- [ ] **Step 6: 커밋**

```bash
git add frontend/lib/role.ts frontend/lib/role.test.ts
git commit -m "feat(frontend): add roleFromGroups util"
```

---

### Task 5: `components/RoleBadge.tsx` — 역할 배지 UI

**Files:**
- Create: `frontend/components/RoleBadge.tsx`
- Create: `frontend/components/RoleBadge.test.tsx`

스펙 §1.1 의 `type Props = { role: "admin" | "user"; withLabel?: boolean }` 시그니처를 그대로 따른다. 라벨/색상 스타일도 스펙 표 그대로.

- [ ] **Step 1: 실패 테스트 작성 — `frontend/components/RoleBadge.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RoleBadge } from "./RoleBadge";

describe("RoleBadge", () => {
  it("renders admin label when role=admin and withLabel", () => {
    render(<RoleBadge role="admin" withLabel />);
    expect(screen.getByText(/Admin · 템플릿 작성/)).toBeInTheDocument();
  });

  it("renders user label when role=user and withLabel", () => {
    render(<RoleBadge role="user" withLabel />);
    expect(screen.getByText(/User · 카탈로그 소비/)).toBeInTheDocument();
  });

  it("renders short label when withLabel is omitted", () => {
    render(<RoleBadge role="admin" />);
    expect(screen.getByText("Admin")).toBeInTheDocument();
    expect(screen.queryByText(/템플릿 작성/)).not.toBeInTheDocument();
  });

  it("applies purple palette for admin", () => {
    const { container } = render(<RoleBadge role="admin" />);
    expect(container.firstChild).toHaveClass("bg-purple-50");
    expect(container.firstChild).toHaveClass("text-purple-800");
  });

  it("applies teal palette for user", () => {
    const { container } = render(<RoleBadge role="user" />);
    expect(container.firstChild).toHaveClass("bg-teal-50");
    expect(container.firstChild).toHaveClass("text-teal-800");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && pnpm test components/RoleBadge.test.tsx`
Expected: FAIL — `Cannot find module './RoleBadge'`.

- [ ] **Step 3: 구현 — `frontend/components/RoleBadge.tsx`**

```tsx
import type { Role } from "@/lib/role";

type Props = { role: Role; withLabel?: boolean };

const palette: Record<Role, string> = {
  admin: "bg-purple-50 text-purple-800",
  user: "bg-teal-50 text-teal-800",
};

const shortLabel: Record<Role, string> = {
  admin: "Admin",
  user: "User",
};

const longLabel: Record<Role, string> = {
  admin: "Admin · 템플릿 작성",
  user: "User · 카탈로그 소비",
};

export function RoleBadge({ role, withLabel = false }: Props) {
  return (
    <span
      className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium ${palette[role]}`}
    >
      {withLabel ? longLabel[role] : shortLabel[role]}
    </span>
  );
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && pnpm test components/RoleBadge.test.tsx`
Expected: `5 passed`.

- [ ] **Step 5: 타입·린트·빌드 확인**

Run: `cd frontend && pnpm lint && pnpm build`
Expected: 통과.

- [ ] **Step 6: 커밋**

```bash
git add frontend/components/RoleBadge.tsx frontend/components/RoleBadge.test.tsx
git commit -m "feat(frontend): add RoleBadge component (admin/user palette)"
```

---

### Task 6: shadcn Badge variants 확장 (`success`, `warning`, `muted`)

**Files:**
- Modify: `frontend/components/ui/badge.tsx`

현재 variant: `default | secondary | destructive | outline | ghost | link`. 스펙 §1.2 의 `success | warning | danger | muted` 를 충족하려면 `danger` 는 기존 `destructive` 를 재사용하고, `success` / `warning` / `muted` 세 개를 추가한다.

- [ ] **Step 1: 현재 `badge.tsx` 를 읽고 `cva` variants 섹션 위치 확인**

Run: `sed -n '/variants:/,/defaultVariants/p' frontend/components/ui/badge.tsx`
Expected: 현재 variant object 출력. `success` / `warning` / `muted` 는 없음.

- [ ] **Step 2: `cva` 의 `variants.variant` 객체에 세 variant 추가**

`frontend/components/ui/badge.tsx` 의 `variant:` 객체 안, 기존 항목 끝에 추가:

```ts
        success:
          "bg-green-100 text-green-800 [a]:hover:bg-green-200",
        warning:
          "bg-amber-100 text-amber-800 [a]:hover:bg-amber-200",
        muted:
          "bg-slate-100 text-slate-600 [a]:hover:bg-slate-200",
```

- [ ] **Step 3: 테스트로 신규 variant 검증 — `frontend/components/ui/badge.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Badge } from "./badge";

describe("Badge variants", () => {
  it("renders success variant with green palette", () => {
    const { container } = render(<Badge variant="success">ok</Badge>);
    expect(container.firstChild).toHaveClass("bg-green-100");
  });
  it("renders warning variant with amber palette", () => {
    const { container } = render(<Badge variant="warning">wip</Badge>);
    expect(container.firstChild).toHaveClass("bg-amber-100");
  });
  it("renders muted variant with slate palette", () => {
    const { container } = render(<Badge variant="muted">off</Badge>);
    expect(container.firstChild).toHaveClass("bg-slate-100");
  });
});
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && pnpm test components/ui/badge.test.tsx`
Expected: `3 passed`.

- [ ] **Step 5: 빌드·린트 확인**

Run: `cd frontend && pnpm lint && pnpm build`
Expected: 통과.

- [ ] **Step 6: 커밋**

```bash
git add frontend/components/ui/badge.tsx frontend/components/ui/badge.test.tsx
git commit -m "feat(frontend): extend Badge variants — success/warning/muted"
```

---

### Task 7: `components/StatusChip.tsx` — 의미 기반 상태 배지

**Files:**
- Create: `frontend/components/StatusChip.tsx`
- Create: `frontend/components/StatusChip.test.tsx`

스펙 §1.2. 기존 `StatusBadge.tsx` 의 `status: string` API (freeform) 대신 명시적 variant prop API 로 전환한다. 동시에 기존 usage 와 호환되도록 편의 헬퍼 `statusChipVariantFromRelease(status)` 도 함께 export 한다.

- [ ] **Step 1: 실패 테스트 작성 — `frontend/components/StatusChip.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusChip, statusChipVariantFromRelease } from "./StatusChip";

describe("StatusChip", () => {
  it("renders label with variant classes", () => {
    const { container } = render(<StatusChip variant="success">OK</StatusChip>);
    expect(screen.getByText("OK")).toBeInTheDocument();
    expect(container.firstChild).toHaveClass("bg-green-100");
  });

  it("warning variant uses amber palette", () => {
    const { container } = render(<StatusChip variant="warning">...</StatusChip>);
    expect(container.firstChild).toHaveClass("bg-amber-100");
  });

  it("danger variant uses destructive palette", () => {
    const { container } = render(<StatusChip variant="danger">!</StatusChip>);
    // shadcn destructive variant uses bg-destructive/10
    expect(container.firstChild?.className).toMatch(/destructive/);
  });
});

describe("statusChipVariantFromRelease", () => {
  it("maps 'healthy' → success", () => {
    expect(statusChipVariantFromRelease("healthy")).toBe("success");
  });
  it("maps 'warning' → warning", () => {
    expect(statusChipVariantFromRelease("warning")).toBe("warning");
  });
  it("maps 'error' / 'failed' → danger", () => {
    expect(statusChipVariantFromRelease("error")).toBe("danger");
    expect(statusChipVariantFromRelease("failed")).toBe("danger");
  });
  it("maps 'deprecated' / unknown → muted", () => {
    expect(statusChipVariantFromRelease("deprecated")).toBe("muted");
    expect(statusChipVariantFromRelease("xyz")).toBe("muted");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && pnpm test components/StatusChip.test.tsx`
Expected: FAIL — `Cannot find module './StatusChip'`.

- [ ] **Step 3: 구현 — `frontend/components/StatusChip.tsx`**

```tsx
import { Badge } from "@/components/ui/badge";

export type StatusVariant = "success" | "warning" | "danger" | "muted";

const variantToBadge: Record<StatusVariant, "success" | "warning" | "destructive" | "muted"> = {
  success: "success",
  warning: "warning",
  danger: "destructive",
  muted: "muted",
};

type Props = {
  variant: StatusVariant;
  children: React.ReactNode;
  className?: string;
};

export function StatusChip({ variant, children, className }: Props) {
  return (
    <Badge variant={variantToBadge[variant]} className={className}>
      {children}
    </Badge>
  );
}

export function statusChipVariantFromRelease(status: string): StatusVariant {
  switch (status) {
    case "healthy":
      return "success";
    case "warning":
      return "warning";
    case "error":
    case "failed":
      return "danger";
    case "deprecated":
      return "muted";
    default:
      return "muted";
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && pnpm test components/StatusChip.test.tsx`
Expected: `7 passed`.

- [ ] **Step 5: 빌드·린트 확인**

Run: `cd frontend && pnpm lint && pnpm build`
Expected: 통과.

- [ ] **Step 6: 커밋**

```bash
git add frontend/components/StatusChip.tsx frontend/components/StatusChip.test.tsx
git commit -m "feat(frontend): add StatusChip wrapping Badge with semantic variants"
```

---

### Task 8: 기존 `StatusBadge` 호출부를 `StatusChip` 으로 마이그레이션 후 삭제

**Files:**
- Modify: `frontend/components/ReleaseTable.tsx` (import 교체, usage 교체)
- Modify: `frontend/app/releases/[id]/page.tsx` (import 교체, usage 교체)
- Delete: `frontend/components/StatusBadge.tsx`

- [ ] **Step 1: 호출 지점 재확인**

Run: `grep -rn StatusBadge frontend`
Expected: 3 위치 — `StatusBadge.tsx` (정의), `ReleaseTable.tsx` (사용), `app/releases/[id]/page.tsx` (사용).

- [ ] **Step 2: `frontend/components/ReleaseTable.tsx` — import + usage 교체**

`import { StatusBadge } from "./StatusBadge";` →
```tsx
import { StatusChip, statusChipVariantFromRelease } from "./StatusChip";
```

`<StatusBadge status={r.status ?? "unknown"} />` →
```tsx
<StatusChip variant={statusChipVariantFromRelease(r.status ?? "unknown")}>
  {r.status ?? "unknown"}
</StatusChip>
```

- [ ] **Step 3: `frontend/app/releases/[id]/page.tsx` — 동일 패턴으로 교체**

`import { StatusBadge } from "@/components/StatusBadge";` →
```tsx
import { StatusChip, statusChipVariantFromRelease } from "@/components/StatusChip";
```

`<StatusBadge status={d.status} />` →
```tsx
<StatusChip variant={statusChipVariantFromRelease(d.status)}>{d.status}</StatusChip>
```

- [ ] **Step 4: `StatusBadge.tsx` 삭제**

Run: `rm frontend/components/StatusBadge.tsx`

- [ ] **Step 5: 레퍼런스 잔존 확인**

Run: `grep -rn StatusBadge frontend`
Expected: 출력 없음.

- [ ] **Step 6: 타입·린트·빌드 확인**

Run: `cd frontend && pnpm test && pnpm lint && pnpm build`
Expected: 모두 통과. 이전 테스트도 계속 통과해야 함.

- [ ] **Step 7: 커밋**

```bash
git add frontend/components/ReleaseTable.tsx frontend/app/releases/[id]/page.tsx frontend/components/StatusBadge.tsx
git commit -m "refactor(frontend): migrate StatusBadge callers to StatusChip, remove StatusBadge"
```

---

### Task 9: `app/providers.tsx` — TanStack Query Provider

**Files:**
- Create: `frontend/app/providers.tsx`
- Modify: `frontend/app/layout.tsx`

클라이언트 컴포넌트로 QueryClient 를 생성하고 `QueryClientProvider` 로 감싼다. 스펙 §7.3.

- [ ] **Step 1: `frontend/app/providers.tsx` 작성**

```tsx
"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
```

- [ ] **Step 2: `frontend/app/layout.tsx` 에서 children 을 `<Providers>` 로 감싸기**

기존 `<main>{children}</main>` → `<main><Providers>{children}</Providers></main>` 가 되도록 수정하고, 파일 상단에 `import { Providers } from "./providers";` 추가.

완성된 body 영역:
```tsx
<body className="min-h-full flex flex-col bg-slate-50">
  <TopBar />
  <main className="max-w-6xl mx-auto w-full p-6">
    <Providers>{children}</Providers>
  </main>
</body>
```

- [ ] **Step 3: 빌드·린트 확인**

Run: `cd frontend && pnpm lint && pnpm build`
Expected: 통과.

- [ ] **Step 4: 스모크 — dev 서버 올리고 홈 페이지가 여전히 렌더되는지 확인**

Run: `cd frontend && pnpm dev` (백그라운드)
브라우저로 `http://localhost:3000` 열기, 기존 탑바/홈이 그대로 보이면 OK. Ctrl+C 로 종료.

참고: Playwright MCP 가 있다면 `browser_navigate` → `browser_snapshot` 으로 대체 가능.

- [ ] **Step 5: 커밋**

```bash
git add frontend/app/providers.tsx frontend/app/layout.tsx
git commit -m "feat(frontend): add TanStack Query Providers wrapping route children"
```

---

### Task 10: `components/TopBar.tsx` 재편 — RoleBadge + DropdownMenu

**Files:**
- Modify: `frontend/components/TopBar.tsx`

현재 TopBar 는 Server Component 로 `/v1/me` 를 서버에서 fetch 한다. 이 구조를 유지한다. 변경점:
1. `roleFromGroups(me?.groups)` 로 role 계산, `<RoleBadge role={role} withLabel />` 로 우측에 렌더.
2. 로그아웃을 DropdownMenu 로 묶어 이메일·역할·로그아웃을 드롭다운 아이템으로 노출.
3. 클러스터 드롭다운은 그대로.

주의: DropdownMenu 는 클라이언트 상호작용이 필요하다 → 해당 부분만 별도 client component 로 분리 (`TopBarUserMenu.tsx`), TopBar 는 서버에서 데이터 페치 + 구조만 그리고 user menu 는 client 에 위임.

- [ ] **Step 1: `frontend/components/TopBarUserMenu.tsx` 신규 작성 (client component)**

```tsx
"use client";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { RoleBadge } from "./RoleBadge";
import type { Role } from "@/lib/role";

type Props = { email: string; role: Role };

export function TopBarUserMenu({ email, role }: Props) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-2 rounded px-2 py-1 hover:bg-slate-800">
          <RoleBadge role={role} />
          <span className="opacity-80 text-sm">{email}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled>
          <RoleBadge role={role} withLabel />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <form action="/api/auth/logout" method="POST">
            <button type="submit" className="w-full text-left">로그아웃</button>
          </form>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 2: `frontend/components/TopBar.tsx` 수정 — 서버에서 role 계산 + UserMenu 위임**

```tsx
import Link from "next/link";
import { ClusterPicker } from "./ClusterPicker";
import { TopBarUserMenu } from "./TopBarUserMenu";
import { apiFetch } from "@/lib/api-server";
import { roleFromGroups, type Role } from "@/lib/role";

const NAV_BY_ROLE: Record<Role, Array<{ href: string; label: string }>> = {
  user: [
    { href: "/catalog", label: "카탈로그" },
    { href: "/releases", label: "내 릴리스" },
  ],
  admin: [
    { href: "/templates", label: "Templates" },
    { href: "/releases", label: "Releases" },
    { href: "/admin/teams", label: "Teams" },
  ],
};

export async function TopBar() {
  const me = await apiFetch("/v1/me")
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

  const role = roleFromGroups(me?.groups ?? null);
  const email = me?.email ?? "…";
  const nav = NAV_BY_ROLE[role];

  return (
    <header className="flex items-center gap-6 bg-slate-900 text-slate-100 px-6 py-3 text-sm">
      <Link href="/" className="font-bold">kubeport</Link>
      <ClusterPicker />
      <nav className="flex gap-4 ml-auto">
        {nav.map((item) => (
          <Link key={item.href} href={item.href}>{item.label}</Link>
        ))}
      </nav>
      <TopBarUserMenu email={email} role={role} />
    </header>
  );
}
```

네비 차이: User 는 "카탈로그 / 내 릴리스", Admin 은 "Templates / Releases / Teams". 스펙 §2.1 에서 Admin 에 "Clusters" 도 있었으나 해당 라우트가 아직 없으므로(`/admin/teams` 만 존재) 제외. Clusters 페이지가 추가될 때 이 배열에 항목을 넣으면 된다.

- [ ] **Step 3: TopBarUserMenu 스모크 테스트 — `frontend/components/TopBarUserMenu.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TopBarUserMenu } from "./TopBarUserMenu";

describe("TopBarUserMenu", () => {
  it("renders email and role badge", () => {
    render(<TopBarUserMenu email="a@b.co" role="admin" />);
    expect(screen.getByText("a@b.co")).toBeInTheDocument();
    // RoleBadge short label
    expect(screen.getAllByText("Admin").length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 4: 테스트 통과 + 빌드 확인**

Run: `cd frontend && pnpm test && pnpm lint && pnpm build`
Expected: 모든 테스트 통과, 빌드 성공.

- [ ] **Step 5: 브라우저 스모크 — RoleBadge 실렌더 확인**

`pnpm dev` 로 구동 후 `http://localhost:3000` 열어서:
- 우상단에 사용자 이메일 옆으로 RoleBadge (Admin 또는 User) 가 보이는지
- 이메일 클릭 시 드롭다운이 열리고 "로그아웃" 항목이 있는지

Playwright MCP 가 붙어 있으면: `browser_navigate("/")` → `browser_snapshot` 으로 확인.

- [ ] **Step 6: 커밋**

```bash
git add frontend/components/TopBar.tsx frontend/components/TopBarUserMenu.tsx frontend/components/TopBarUserMenu.test.tsx
git commit -m "feat(frontend): TopBar integrates RoleBadge + DropdownMenu user menu"
```

---

### Task 11: `stores/kube-terms-store.ts` — Zustand 스토어 스캐폴드

**Files:**
- Create: `frontend/stores/kube-terms-store.ts`
- Create: `frontend/stores/kube-terms-store.test.ts`

Plan 2 (릴리스 상세) 에서 실사용. 여기서는 스토어 정의 + 토글 동작 테스트까지만 한다.

- [ ] **Step 1: 실패 테스트 — `frontend/stores/kube-terms-store.test.ts`**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useKubeTermsStore } from "./kube-terms-store";

describe("useKubeTermsStore", () => {
  beforeEach(() => {
    useKubeTermsStore.setState({ showKubeTerms: false });
  });

  it("defaults showKubeTerms to false", () => {
    expect(useKubeTermsStore.getState().showKubeTerms).toBe(false);
  });

  it("toggle() flips the flag", () => {
    useKubeTermsStore.getState().toggle();
    expect(useKubeTermsStore.getState().showKubeTerms).toBe(true);
    useKubeTermsStore.getState().toggle();
    expect(useKubeTermsStore.getState().showKubeTerms).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && pnpm test stores/kube-terms-store.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현 — `frontend/stores/kube-terms-store.ts`**

```ts
import { create } from "zustand";

type KubeTermsState = {
  showKubeTerms: boolean;
  toggle: () => void;
};

export const useKubeTermsStore = create<KubeTermsState>((set) => ({
  showKubeTerms: false,
  toggle: () => set((s) => ({ showKubeTerms: !s.showKubeTerms })),
}));
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && pnpm test stores/kube-terms-store.test.ts`
Expected: `2 passed`.

- [ ] **Step 5: 빌드·린트 확인**

Run: `cd frontend && pnpm lint && pnpm build`
Expected: 통과.

- [ ] **Step 6: 커밋**

```bash
git add frontend/stores/kube-terms-store.ts frontend/stores/kube-terms-store.test.ts
git commit -m "feat(frontend): scaffold kube-terms Zustand store (used in Plan 2)"
```

---

### Task 12: `components/MonacoPanel.tsx` — 공통 Monaco 래퍼

**Files:**
- Create: `frontend/components/MonacoPanel.tsx`

스펙 §1.3. 기존 `YamlEditor.tsx` 와 `YamlPreview.tsx` 가 각자 Monaco 를 dynamic import 한다. 앞으로 Admin UI 에디터의 YamlPreview 가 read-only 모드를, Template YAML 편집은 editable 모드를 필요로 하므로, 공통 래퍼를 먼저 만들어둔다. **마이그레이션 (기존 컴포넌트를 이 래퍼로 리라이트) 은 Plan 4 에서.** 여기서는 스캐폴드만.

테스트는 dynamic import + Monaco 가 jsdom 에서 mount 에러를 낼 수 있어 스냅샷 대신 **smoke-level** 로: 파일이 import 되고 함수 시그니처가 export 되는지만.

- [ ] **Step 1: 구현 — `frontend/components/MonacoPanel.tsx`**

```tsx
"use client";

import dynamic from "next/dynamic";

const Editor = dynamic(() => import("@monaco-editor/react").then((m) => m.default), {
  ssr: false,
});

export type MonacoPanelProps = {
  value: string;
  readOnly?: boolean;
  onChange?: (value: string | undefined) => void;
  language?: "yaml" | "json";
  height?: number | string;
};

export function MonacoPanel({
  value,
  readOnly = false,
  onChange,
  language = "yaml",
  height = "100%",
}: MonacoPanelProps) {
  return (
    <Editor
      value={value}
      language={language}
      height={height}
      theme="vs-dark"
      onChange={onChange}
      options={{
        readOnly,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 13,
        tabSize: 2,
      }}
    />
  );
}
```

- [ ] **Step 2: import 스모크 테스트 — `frontend/components/MonacoPanel.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { MonacoPanel } from "./MonacoPanel";

describe("MonacoPanel module", () => {
  it("exports a function component", () => {
    expect(typeof MonacoPanel).toBe("function");
  });
});
```

주의: `render(<MonacoPanel …/>)` 은 현재 jsdom 환경에서 dynamic import + worker 셋업 때문에 실패 가능성이 높다. 실제 rendering 검증은 Plan 4 에서 브라우저 스모크로 대신한다.

- [ ] **Step 3: 테스트 + 빌드 통과 확인**

Run: `cd frontend && pnpm test components/MonacoPanel.test.tsx && pnpm lint && pnpm build`
Expected: 통과.

- [ ] **Step 4: 커밋**

```bash
git add frontend/components/MonacoPanel.tsx frontend/components/MonacoPanel.test.tsx
git commit -m "feat(frontend): add MonacoPanel wrapper (scaffold for Plan 4 migration)"
```

---

## 검증 (End-to-end)

Plan 0 완료 시점에 다음이 모두 만족되어야 한다:

1. **빌드·린트·테스트 올 그린**:
   ```bash
   cd frontend && pnpm test && pnpm lint && pnpm build
   ```
   모두 통과. 신규 테스트 총합이 기존보다 많아야 함 (role·RoleBadge·Badge·StatusChip·TopBarUserMenu·kube-terms ≥ 20 개).

2. **브라우저 스모크** (dev 서버 기준):
   - `/` 홈: TopBar 에 `RoleBadge` (이메일 왼쪽) 노출
   - 이메일 클릭 → DropdownMenu 가 열리고 로그아웃 폼이 나옴 → 제출 시 `/api/auth/logout` 으로 POST
   - User 로그인: 네비에 "카탈로그 / 내 릴리스" 만 보임 (Templates/Teams 는 숨김)
   - Admin 로그인: 네비에 "Templates / Releases / Teams" 가 보임 (카탈로그는 숨김)
   - `/catalog`, `/releases/…`: 기존 화면이 깨지지 않고 렌더 (리디자인은 후속 플랜)
   - `/releases/[id]`: StatusChip 이 기존 `healthy`/`error` 값으로 바르게 색칠됨

3. **Role 확인 매트릭스** (dex 로컬 OIDC 기준; `docs/testing.md` 참조):
   - `admin@kubeport.local` (groups 에 `kubeport-admin`) → `RoleBadge` 가 purple 팔레트 + "Admin"
   - `user@kubeport.local` (없음) → teal 팔레트 + "User"

4. **코드 정리 확인**:
   - `grep -rn StatusBadge frontend` → no matches
   - `frontend/components/StatusBadge.tsx` → not present

5. **패키지 위생**:
   - `frontend/package.json` 의 `dependencies` 에 `@tanstack/react-query`, `zustand`, `use-debounce` 가 존재
   - `devDependencies` 에 `vitest`, `@testing-library/react`, `jsdom` 가 존재
   - `frontend/components/ui/` 파일 수 = 20

---

## 다음 단계

이 플랜 완료 후:
- **Plan 1 (카탈로그 리디자인)** — `/catalog` + CatalogCard + 태그 필터 / 검색 / 아이콘 맵
- **Plan 2 (릴리스 상세 리디자인)** — 중첩 라우트로 전환 + 개요·로그 탭 + k8s 용어 토글 (스토어 활용)
- **Plan 3 (배포 폼 리디자인)** — `schemaFromUISpec` + DynamicForm 타입 매핑 + RBAC 패널
- **Plan 4 (Admin UI 에디터 리디자인)** — Resizable 3-pane + 선택 하이라이트 + save/publish

각 플랜은 이 Foundation 의 산출물(RoleBadge, StatusChip, 확장된 Badge, shadcn 컴포넌트, TanStack Query, Zustand 스토어, Vitest 인프라)을 전제로 한다.
