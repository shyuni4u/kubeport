"use client";

// A submit button that asks for confirmation before letting the enclosing
// <form action={serverAction}> submit. Used for destructive server-action
// forms (publish / deprecate / undeprecate / delete draft). Keeping type as
// "submit" (the default for a <button> inside a form) means preventDefault()
// in the onClick handler cancels the form submission when the user declines.
export function ConfirmSubmit({
  message,
  className,
  children,
}: {
  message: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="submit"
      className={className}
      onClick={(e) => {
        if (!confirm(message)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
