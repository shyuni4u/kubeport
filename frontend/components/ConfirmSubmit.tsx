"use client";

import { useFormStatus } from "react-dom";

// A submit button that asks for confirmation before letting the enclosing
// <form action={serverAction}> submit. Used for destructive server-action
// forms (publish / deprecate / undeprecate / delete draft). Keeping type as
// "submit" (the default for a <button> inside a form) means preventDefault()
// in the onClick handler cancels the form submission when the user declines.
//
// While the server action is in flight (useFormStatus().pending) the button
// is disabled so a double-click can't fire the action twice; the confirm
// dialog is skipped in that state as well.
export function ConfirmSubmit({
  message,
  className,
  title,
  children,
}: {
  message: string;
  className?: string;
  title?: string;
  children: React.ReactNode;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={className}
      title={title}
      disabled={pending}
      aria-busy={pending}
      onClick={(e) => {
        if (pending || !confirm(message)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
