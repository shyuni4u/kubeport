import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

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

// A hand-written `<th>` does not get the default above, which is how the gap
// went unnoticed. Every one in app code has to state its scope. The files are
// parsed as TSX rather than matched with a regex, so a `>` inside an attribute
// expression, spacing around `=`, a commented-out tag or a look-alike attribute
// such as `data-scope` cannot fool the check.
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

  function thWithoutScope(fileName: string, source: string): number[] {
    const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const lines: number[] = [];
    const visit = (node: ts.Node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        node.tagName.getText(file) === "th"
      ) {
        const hasScope = node.attributes.properties.some(
          (p) => ts.isJsxAttribute(p) && p.name.getText(file) === "scope",
        );
        // A spread may carry scope; only a literal th with no spread is checked.
        const hasSpread = node.attributes.properties.some(ts.isJsxSpreadAttribute);
        if (!hasScope && !hasSpread) {
          lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return lines;
  }

  it("has no header cell without scope", () => {
    const missing = dirs
      .flatMap(tsxFiles)
      .flatMap((f) => thWithoutScope(f, readFileSync(f, "utf8")).map((line) => `${relative(root, f)}:${line}`));
    expect(missing).toEqual([]);
  });

  // The check itself, on the shapes a regex got wrong.
  it("reads JSX, not text", () => {
    const check = (src: string) => thWithoutScope("probe.tsx", `export const X = () => (${src});`);
    expect(check(`<th data-scope="col">a</th>`)).toEqual([1]);
    expect(check(`<th scope = "col">a</th>`)).toEqual([]);
    expect(check(`<th onClick={() => sort()} scope="col">a</th>`)).toEqual([]);
    expect(check(`<div>{/* <th>a</th> */}</div>`)).toEqual([]);
    expect(check(`<thead><tr><td>a</td></tr></thead>`)).toEqual([]);
  });
});
