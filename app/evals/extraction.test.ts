// LLM extraction evals (SPEC §11). These call the real provider and cost
// money, so they only run with RUN_LLM_EVALS=1 (`npm run evals`).
import { describe, expect, it } from "vitest";
import { extractSpot } from "../src/lib/llm";
import { prepareSolve } from "../src/lib/request";
import type { Extraction } from "../src/lib/schema";
import fixtures from "./fixtures.json";

type Expected = { $oneOf: unknown[] } | unknown;
type Fixture = {
  id: string;
  prompt: string;
  expected: Partial<Record<keyof Extraction, Expected>>;
  /** "ok" or the cant_solve reason prepareSolve() should return. */
  outcome: string;
};

const RUN = process.env.RUN_LLM_EVALS === "1";

if (RUN) {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // Fall back to whatever is already in the environment.
  }
}

/** Strings compare ignoring whitespace; objects compare field by field. */
function matches(actual: unknown, expected: Expected): boolean {
  if (expected !== null && typeof expected === "object" && "$oneOf" in expected) {
    return (expected as { $oneOf: unknown[] }).$oneOf.some((e) => matches(actual, e));
  }
  if (typeof expected === "string" && typeof actual === "string") {
    return expected.replace(/\s+/g, "") === actual.replace(/\s+/g, "");
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object") return false;
    return Object.entries(expected).every(([k, v]) => matches((actual as Record<string, unknown>)[k], v));
  }
  return actual === expected;
}

describe.skipIf(!RUN)("LLM extraction evals", () => {
  it(
    "extracts every fixture as expected",
    async () => {
      const results = await Promise.all(
        (fixtures as Fixture[]).map(async (f) => {
          const out = await extractSpot(f.prompt);
          const mismatches = Object.entries(f.expected)
            .filter(([k, v]) => !matches(out[k as keyof Extraction], v))
            .map(([k, v]) => `${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(out[k as keyof Extraction])}`);
          const prepared = prepareSolve(out);
          const outcome = prepared.ok ? "ok" : prepared.error.reason;
          if (outcome !== f.outcome) mismatches.push(`outcome: expected ${f.outcome}, got ${outcome}`);
          return { f, out, mismatches, assumptions: prepared.ok ? prepared.assumptions : [] };
        }),
      );

      for (const r of results) {
        console.log(
          `\n=== ${r.f.id} ${r.mismatches.length ? "FAIL" : "PASS"}\n> ${r.f.prompt}\n${JSON.stringify(r.out, null, 2)}` +
            (r.assumptions.length ? `\nassumptions:\n  - ${r.assumptions.join("\n  - ")}` : "") +
            (r.mismatches.length ? `\nMISMATCHES:\n  - ${r.mismatches.join("\n  - ")}` : ""),
        );
      }
      const passed = results.filter((r) => r.mismatches.length === 0).length;
      console.log(`\n${passed}/${results.length} fixtures passed (model: ${process.env.LLM_MODEL})`);
      expect(results.filter((r) => r.mismatches.length).map((r) => r.f.id)).toEqual([]);
    },
    120_000,
  );
});
