"use client";

import { useActionState } from "react";

import { cn } from "@/lib/utils";

// Result shape shared by the server actions rendered through ActionForm.
// `{}` (or undefined) means success; `error` is an already-localized,
// user-facing sentence — never the raw backend body.
export type ActionState = { error?: string } | undefined;

export type FormAction = (
  prev: ActionState,
  formData: FormData,
) => Promise<ActionState>;

// ActionForm wraps a server action with useActionState so a failure is shown
// inline next to the controls instead of throwing (which in production shows
// a generic crash screen). Children are the form's own controls — typically
// a hidden input plus a ConfirmSubmit — passed straight through from the
// server component that owns the action.
export function ActionForm({
  action,
  className,
  children,
}: {
  action: FormAction;
  className?: string;
  children: React.ReactNode;
}) {
  const [state, formAction] = useActionState(action, undefined);
  return (
    <form action={formAction} className={className}>
      {children}
      {state?.error ? (
        <span
          role="alert"
          className={cn("text-xs text-red-600", className ? "self-center" : "ml-2")}
        >
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
