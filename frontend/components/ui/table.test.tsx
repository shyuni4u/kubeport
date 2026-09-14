import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";

// #379: no header in the app carried `scope`, so a screen reader could not tie
// a cell to its header (WCAG 1.3.1).
describe("TableHead", () => {
  it("is a column header by default", () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>이름</TableHead>
          </TableRow>
        </TableHeader>
      </Table>,
    );
    expect(screen.getByRole("columnheader", { name: "이름" })).toHaveAttribute("scope", "col");
  });

  it("lets a caller mark a row header", () => {
    render(
      <Table>
        <TableBody>
          <TableRow>
            <TableHead scope="row">web-1</TableHead>
            <TableCell>Running</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole("rowheader", { name: "web-1" })).toHaveAttribute("scope", "row");
  });
});

// A hand-written `<th>` elsewhere does not get the default above, which is how
// the gap went unnoticed. Every one in app code has to state its scope.
describe("every <th> in the app states a scope", () => {
  // Vitest runs from the frontend package root.
  const root = process.cwd();
  const dirs = ["app", "components"].map((d) => join(root, d));

  function tsxFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "node_modules" ? [] : tsxFiles(path);
      return name.endsWith(".tsx") && !name.endsWith(".test.tsx") ? [path] : [];
    });
  }

  it("has no header cell without scope", () => {
    const missing: string[] = [];
    for (const file of dirs.flatMap(tsxFiles)) {
      const source = readFileSync(file, "utf8");
      // The opening tag, up to its closing `>`, may span lines.
      for (const match of source.matchAll(/<th(?=[\s>])[^>]*>/g)) {
        if (!/\bscope=/.test(match[0])) {
          const line = source.slice(0, match.index).split("\n").length;
          missing.push(`${relative(root, file)}:${line}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
