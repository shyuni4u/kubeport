"use client";

import { Button } from "@/components/ui/button";
import { useFormStatus } from "react-dom";

// A submit button that asks for confirmation before letting the enclosing
// <form action={serverAction}> submit. Used for destructive server-action
// forms (publish / deprecate / undeprecate / delete draft). Keeping type as
// "submit" (the default for a <Button> inside a form) means preventDefault()
// in the onClick handler cancels the form submission when the user declines.
//
// While the server action is in flight (useFormStatus().pending) the button
// is disabled so a double-click can't fire the action twice; the confirm
// dialog is skipped in that state as well.
export function ConfirmSubmit({
  message,
  className,
  title,
  disabled = false,
  variant = "outline",
  children,
}: {
  message: string;
  className?: string;
  title?: string;
  disabled?: boolean;
  variant?: "outline" | "destructive" | "default";
  children: React.ReactNode;
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant={variant}
      className={className}
      title={title}
      disabled={disabled || pending}
      aria-busy={pending}
      onClick={(e) => {
        if (disabled || pending || !confirm(message)) e.preventDefault();
      }}
    >
      {children}
    </Button>
  );
}
