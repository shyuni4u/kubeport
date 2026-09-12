import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { stableStringify, useDirtyAgainstBaseline } from "./useDirtyGuard";

// A stand-in editor: `text` is what a save would send, `dirty` is the page's
// flag, and each button is an edit handler — setting the text and marking
// dirty at once, the way the editor pages do. "start save" keeps the
// markSaved of that render, as an async save() does, and "save succeeds"
// calls it later.
function Editor({ initial }: { initial: string | null }) {
  const [text, setText] = useState<string | null>(initial);
  const [dirty, setDirty] = useState(false);
  const markSaved = useDirtyAgainstBaseline(text, dirty, setDirty);
  const pending = useRef<(() => void) | null>(null);
  const edit = (next: string) => () => {
    setText(next);
    setDirty(true);
  };
  return (
    <>
      <output aria-label="dirty">{String(dirty)}</output>
      <button onClick={() => setText("loaded")}>load</button>
      <button onClick={edit("a")}>set a</button>
      <button onClick={edit("ab")}>set ab</button>
      <button onClick={edit("loaded")}>set loaded</button>
      <button onClick={edit("loaded + edit")}>set loaded + edit</button>
      <button onClick={() => setDirty(true)}>touch only</button>
      <button onClick={markSaved}>saved</button>
      <button onClick={() => { pending.current = markSaved; }}>start save</button>
      <button onClick={() => pending.current?.()}>save succeeds</button>
    </>
  );
}

const dirty = () => screen.getByLabelText("dirty").textContent;
const press = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

// #274 — undoing an edit left "unsaved changes" and the leave prompt up, because
// nothing compared the text with what the editor had loaded.
describe("useDirtyAgainstBaseline", () => {
  it("starts clean, turns dirty on a change, and clean again when the change is undone", () => {
    render(<Editor initial="a" />);
    expect(dirty()).toBe("false");
    press("set ab");
    expect(dirty()).toBe("true");
    press("set a");
    expect(dirty()).toBe("false");
  });

  it("clears a mark set by a handler that changed nothing", () => {
    render(<Editor initial="a" />);
    press("touch only");
    expect(dirty()).toBe("false");
  });

  // An edit page is empty until the version loads; the loaded text, not the
  // empty one, is what an undo returns to.
  it("takes the first loaded value as the baseline, not the loading placeholder", () => {
    render(<Editor initial={null} />);
    press("load");
    expect(dirty()).toBe("false");
    press("set loaded + edit");
    expect(dirty()).toBe("true");
    press("set loaded");
    expect(dirty()).toBe("false");
  });

  // A save clears the mark and navigates away. Without moving the baseline the
  // effect saw "differs from the original" and set dirty again meanwhile.
  it("stays clean after a save, and measures later edits from what was saved", () => {
    render(<Editor initial="a" />);
    press("set ab");
    press("saved");
    expect(dirty()).toBe("false");
    press("set a");
    expect(dirty()).toBe("true");
    press("set ab");
    expect(dirty()).toBe("false");
  });

  // Save "ab", undo back to "a" while the request is out: "a" is no longer what
  // is stored, so it must read as unsaved once the save lands.
  it("counts an undo made while the save was in flight", () => {
    render(<Editor initial="a" />);
    press("set ab");
    press("start save");
    press("set a");
    expect(dirty()).toBe("false");
    press("save succeeds");
    expect(dirty()).toBe("true");
  });

  it("counts an edit made while the save was in flight", () => {
    render(<Editor initial="a" />);
    press("set ab");
    press("start save");
    press("set loaded");
    press("save succeeds");
    expect(dirty()).toBe("true");
  });
});

describe("stableStringify", () => {
  // Clearing a field and setting it again moves its key to the end.
  it("serializes the same content the same whatever order its keys were set in", () => {
    const before = { fields: { a: 1, b: { mode: "fixed", value: 2 } }, name: "web" };
    const after = { name: "web", fields: { b: { value: 2, mode: "fixed" }, a: 1 } };
    expect(stableStringify(after)).toBe(stableStringify(before));
  });

  it("keeps array order, which is content", () => {
    expect(stableStringify({ tags: ["a", "b"] })).not.toBe(stableStringify({ tags: ["b", "a"] }));
  });
});
