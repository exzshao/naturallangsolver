// Model-agnostic LLM layer (SPEC §3). The model is picked by LLM_MODEL
// ("provider:model", e.g. "openai:gpt-5.4-mini"). Adding a provider means
// `npm i @ai-sdk/<provider>` plus one entry in the registry below.
//
// Dev only: LLM_MODEL=mock:fixture swaps in canned keyword-matched
// extractions (src/lib/mock-llm.ts) so the app runs without an API key.
// It is refused when NODE_ENV=production.
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { createProviderRegistry, generateText, Output, type LanguageModel } from "ai";
import { mockProvider } from "./mock-llm";
import { EXTRACTION_SYSTEM_PROMPT } from "./prompts";
import { ExtractionSchema, type Extraction } from "./schema";

export const registry = createProviderRegistry({
  openai,
  anthropic,
  mock: mockProvider,
});

export const LLM_TIMEOUT_MS = 20_000;
/**
 * Output cap per extraction. The largest eval fixture (6 actions + notes) is
 * ~300 tokens; a 2000-char input pasted back verbatim as ranges is ~1000. A
 * truncated reply fails schema parsing and surfaces as LLM_UNAVAILABLE.
 */
export const LLM_MAX_OUTPUT_TOKENS = 1200;

/** Thrown for any provider error, timeout, or missing configuration. Maps to cant_solve: LLM_UNAVAILABLE. */
export class LlmUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LlmUnavailableError";
  }
}

type RegistryModelId = Parameters<typeof registry.languageModel>[0];

export function resolveModel(modelId = process.env.LLM_MODEL) {
  if (!modelId) throw new LlmUnavailableError("LLM_MODEL is not set");
  if (modelId.startsWith("mock:") && process.env.NODE_ENV === "production") {
    throw new LlmUnavailableError(`"${modelId}" is a dev-only model and is disabled in production`);
  }
  try {
    return registry.languageModel(modelId as RegistryModelId);
  } catch (cause) {
    throw new LlmUnavailableError(`Unknown LLM_MODEL "${modelId}"`, { cause });
  }
}

/**
 * Extract structured spot parameters from free text. The model defaults to
 * LLM_MODEL via the registry. Throws LlmUnavailableError on any provider
 * failure, timeout, or bad configuration.
 */
export async function extractSpot(
  text: string,
  model: LanguageModel = resolveModel(),
): Promise<Extraction> {
  try {
    const { output } = await generateText({
      model,
      output: Output.object({ schema: ExtractionSchema }),
      instructions: EXTRACTION_SYSTEM_PROMPT,
      prompt: text,
      // Portable settings only. Providers drop what they don't support
      // (e.g. temperature on reasoning models) with a warning.
      temperature: 0,
      reasoning: "none",
      timeout: LLM_TIMEOUT_MS,
      maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
      maxRetries: 1,
    });
    return output;
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new LlmUnavailableError(`LLM extraction failed: ${msg}`, { cause });
  }
}
