import { useEffect, useState } from "react";

export type Theme = "dark" | "light";

// A per-browser convenience only: it may be blocked or empty, and the page then follows the system.
const KEY = "orch.theme";
const remembered = (): Theme | undefined => {
  try {
    const v = localStorage.getItem(KEY);
    return v === "dark" || v === "light" ? v : undefined;
  } catch {
    return undefined;
  }
};
const systemTheme = (): Theme =>
  window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";

/** Applies the stored choice when the app starts, so the sign-in page honours it too. index.html does the same earlier, in the head, so the first paint is right. */
export function initTheme() {
  const theme = remembered();
  if (theme) document.documentElement.setAttribute("data-theme", theme);
  else document.documentElement.removeAttribute("data-theme");
}

/** The theme in use (the chosen one, else the system's) and a way to choose. shortcut: no way back to "follow the system" except clearing storage. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => remembered() ?? systemTheme());
  // with no choice made the CSS follows the system as it changes, so the toggle must too
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    const follow = () => remembered() || setTheme(systemTheme());
    query?.addEventListener("change", follow);
    return () => query?.removeEventListener("change", follow);
  }, []);
  const choose = (next: Theme) => {
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // nothing to do: the choice lasts until the page is reloaded
    }
    document.documentElement.setAttribute("data-theme", next);
    setTheme(next);
  };
  return { theme, choose };
}
