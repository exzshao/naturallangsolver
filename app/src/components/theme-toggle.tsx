"use client";

import { otherTheme, parseTheme, THEME_KEY, type Theme } from "@/lib/theme";
import { useLayoutEffect, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();

function readTheme(): Theme {
  return parseTheme(document.documentElement.getAttribute("data-theme"));
}

function applyTheme(t: Theme) {
  if (t === "dark") document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function readStored(): Theme {
  try {
    return parseTheme(localStorage.getItem(THEME_KEY));
  } catch {
    return "light";
  }
}

/** Plain bracketed text: names the theme you switch to. */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, readTheme, () => "light" as Theme);

  // The inline <head> script sets the attribute before paint. React's dev-mode
  // remount clears it, so re-apply from storage (no-op in production).
  useLayoutEffect(() => {
    applyTheme(readStored());
  }, []);

  function toggle() {
    const next = otherTheme(readTheme());
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {}
  }

  const target = otherTheme(theme);
  return (
    <button type="button" onClick={toggle} aria-label={`Switch to ${target} theme`} className="btn uppercase">
      [{target}]
    </button>
  );
}
