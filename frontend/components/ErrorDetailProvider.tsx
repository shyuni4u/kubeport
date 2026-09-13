"use client";

import { createContext, useContext, useMemo, useState } from "react";
import type { ErrorDetailLevel } from "@/lib/error-detail";

type ErrorDetailContextValue = {
  level: ErrorDetailLevel;
  setLevel: (level: ErrorDetailLevel) => void;
};

// Without a provider — a component rendered on its own, as in a test — errors
// show the least: the screen's sentence and the block to send an admin.
const ErrorDetailContext = createContext<ErrorDetailContextValue>({
  level: "friendly",
  setLevel: () => {},
});

/**
 * How much of a refused request every screen unfolds (#6). The root shell
 * resolves the level on the server — the viewer's cookie, or where their role
 * starts — so the first paint and hydration agree (#247), and it stays mounted
 * across page moves, so a choice made in the header holds on the next page.
 */
export function ErrorDetailProvider({
  initial,
  children,
}: {
  initial: ErrorDetailLevel;
  children: React.ReactNode;
}) {
  const [level, setLevel] = useState<ErrorDetailLevel>(initial);
  const value = useMemo(() => ({ level, setLevel }), [level]);
  return <ErrorDetailContext.Provider value={value}>{children}</ErrorDetailContext.Provider>;
}

export function useErrorDetail(): ErrorDetailContextValue {
  return useContext(ErrorDetailContext);
}
