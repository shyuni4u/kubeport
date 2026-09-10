"use client";

import { Component, type ReactNode } from "react";

type Props = { fallback: (message: string) => ReactNode; children: ReactNode };
type State = { message: string | null };

/**
 * Keeps a failing preview from taking the editor down with it (#164).
 *
 * The editor is the only way the admin can undo whatever caused the failure,
 * so it has to outlive the preview. Without a boundary here, a throw anywhere
 * under DynamicForm unmounted both Monaco instances and replaced the page
 * with "문제가 발생했습니다" — losing the unsaved draft, and inviting a retry
 * that lands on the same character with the same result.
 *
 * Deliberately a boundary and not a `try` around the parse: the render itself
 * is what throws, and the failures worth surviving here are the ones nobody
 * predicted. The specific one that started this is handled properly upstream
 * in `schemaFromUISpec`.
 */
export class PreviewErrorBoundary extends Component<Props, State> {
  state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidUpdate(prev: Props) {
    // The admin's next keystroke is the retry. Without this the fallback
    // would stick for the rest of the session, which reads as "the editor is
    // broken" rather than "that line was".
    if (prev.children !== this.props.children && this.state.message !== null) {
      this.setState({ message: null });
    }
  }

  render() {
    if (this.state.message !== null) return this.props.fallback(this.state.message);
    return this.props.children;
  }
}
