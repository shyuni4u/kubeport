import { useCallback, useState } from "react";

import { requestLogout } from "./logout";

/**
 * Logout for a client component: POST, leave only when it worked, otherwise
 * stay and report it (#166).
 *
 * A hook rather than inline in each button because two places log out — the
 * confirmation screen and the top-bar menu — and the menu cannot be exercised
 * in jsdom (base-ui portals it and needs pointer events), so its behaviour has
 * to be testable without opening it.
 *
 * Leaving uses window.location.assign, not router.push: the cached tree still
 * holds a shell rendered with this user's email, and the session is gone — the
 * document has to be fetched again.
 */
export function useLogout() {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const logout = useCallback(async () => {
    setPending(true);
    setFailed(false);
    if (await requestLogout()) {
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/");
      return;
    }
    setPending(false);
    setFailed(true);
  }, []);

  const dismiss = useCallback(() => setFailed(false), []);

  return { pending, failed, logout, dismiss };
}
