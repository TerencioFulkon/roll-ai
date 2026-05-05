import { useCallback, useEffect, useState } from "react";

export const THEME_STORAGE_KEY = "rollai-theme";

/** @returns {"light" | "dark"} */
function readThemeFromDom() {
  if (typeof document === "undefined") {
    return "dark";
  }
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** @param {"light" | "dark"} theme */
export function applyTheme(theme) {
  const isDark = theme === "dark";
  document.documentElement.classList.toggle("dark", isDark);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
}

/**
 * Synced theme with `document.documentElement` class `dark` and localStorage.
 */
export function useTheme() {
  const [theme, setThemeState] = useState(readThemeFromDom);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const onStorage = (event) => {
      if (event.key !== THEME_STORAGE_KEY || !event.newValue) {
        return;
      }
      if (event.newValue === "light" || event.newValue === "dark") {
        document.documentElement.classList.toggle("dark", event.newValue === "dark");
        setThemeState(event.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setTheme = useCallback((next) => {
    setThemeState(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  return { theme, setTheme, toggleTheme };
}
