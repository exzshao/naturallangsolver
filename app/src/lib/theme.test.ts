import { describe, expect, it } from "vitest";
import { otherTheme, parseTheme, THEME_INIT_SCRIPT, THEME_KEY } from "./theme";

describe("theme", () => {
  it("defaults to light for anything but a stored 'dark'", () => {
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme(null)).toBe("light");
    expect(parseTheme("garbage")).toBe("light");
  });

  it("toggles", () => {
    expect(otherTheme("light")).toBe("dark");
    expect(otherTheme("dark")).toBe("light");
  });

  function runInit(getItem: (k: string) => string | null) {
    const attrs: Record<string, string> = {};
    const document = { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) } };
    new Function("localStorage", "document", THEME_INIT_SCRIPT)({ getItem }, document);
    return attrs;
  }

  it("init script sets data-theme only for a saved dark theme", () => {
    expect(runInit((k) => (k === THEME_KEY ? "dark" : null))).toEqual({ "data-theme": "dark" });
    expect(runInit(() => "light")).toEqual({});
    expect(runInit(() => null)).toEqual({});
  });

  it("init script survives storage that throws", () => {
    expect(
      runInit(() => {
        throw new Error("blocked");
      }),
    ).toEqual({});
  });
});
