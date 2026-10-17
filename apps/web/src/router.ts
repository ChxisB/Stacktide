import { useSyncExternalStore } from "react";

// Hash routes (`#/variables`): the server needs no knowledge of the app's pages, and the API's own
// paths (/auth, /organizations, ...) can never collide with one.
const subscribe = (notify: () => void) => {
  window.addEventListener("hashchange", notify);
  return () => window.removeEventListener("hashchange", notify);
};

/** The current page's path without the `#/`: "" is home, "variables" is the variables page. */
export function useRoute(): string {
  const hash = useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => "",
  );
  return hash.replace(/^#\/?/, "").split("?")[0] ?? "";
}

export const href = (path: string) => `#/${path}`;
