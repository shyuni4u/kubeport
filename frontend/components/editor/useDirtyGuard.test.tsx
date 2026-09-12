import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { useDirtyAgainstBaseline } from "./useDirtyGuard";

// A stand-in editor: `text` is what a save would send, `dirty` is the page's
// flag, and each button is an edit handler — setting the text and marking
// dirty at once, the way the editor pages do.
function Editor({ initial }: { initial: string | null }) {
  const [text, setText] = useState<string | null>(initial);
  const [dirty, setDirty] = useState(false);
  useDirtyAgainstBaseline(text, dirty, setDirty);
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
});
