import { describe, expect, it } from "vitest";
import { resolveModel } from "./llm";

// Resolving a model doesn't call the provider, so no API key is needed.
describe("provider registry", () => {
  it.each([
    ["openai:gpt-5.4-mini", "openai", "gpt-5.4-mini"],
    ["anthropic:claude-haiku-4-5", "anthropic", "claude-haiku-4-5"],
  ])("resolves %s", (id, provider, modelId) => {
    const model = resolveModel(id);
    expect(typeof model === "object" && model.provider.startsWith(provider)).toBe(true);
    expect(typeof model === "object" && model.modelId).toBe(modelId);
  });
});
