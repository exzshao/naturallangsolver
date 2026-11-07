export type Theme = "light" | "dark";

export const THEME_KEY = "theme";

/** Anything other than a stored "dark" means light, the default. */
export function parseTheme(stored: string | null | undefined): Theme {
  return stored === "dark" ? "dark" : "light";
}

export function otherTheme(t: Theme): Theme {
  return t === "dark" ? "light" : "dark";
}

/**
 * Runs in <head> before first paint: sets data-theme="dark" on <html> when the
 * saved choice is dark. Light is the absence of the attribute.
 */
export const THEME_INIT_SCRIPT = `(function(){try{if(localStorage.getItem(${JSON.stringify(THEME_KEY)})==="dark")document.documentElement.setAttribute("data-theme","dark")}catch(e){}})()`;
