import { describe, expect, it, vi } from "vitest";

import {
  MAX_DETECTED_MODEL_CONTEXT_LENGTH,
  MODEL_CONTEXT_LENGTH_FIELD_PATHS,
  modelContextLengthFromFields,
  resolveModelContextLength,
  resolveModelContextLengthWithoutDetection,
} from "../../../app/src/ModelContextLength.mjs";

describe("AI reviewer model context length", function () {
  it("keeps every supported model-list field path in one ordered table", function () {
    expect(MODEL_CONTEXT_LENGTH_FIELD_PATHS).toEqual([
      ["max_input_tokens"],
      ["inputTokenLimit"],
      ["max_model_len"],
      ["max_context_length"],
      ["n_ctx"],
      ["context_window"],
      ["context_length"],
      ["metadata", "context_length"],
      ["contextLength"],
    ]);
    expect(
      modelContextLengthFromFields({
        max_input_tokens: 200_000,
        inputTokenLimit: 1_048_576,
      }),
    ).toBe(200_000);
    expect(
      modelContextLengthFromFields({
        metadata: { context_length: 131_072 },
      }),
    ).toBe(131_072);
  });

  it.each([0, -1, 1.5, "32768", MAX_DETECTED_MODEL_CONTEXT_LENGTH + 1])(
    "does not trust unusable model-list value %j",
    function (detected) {
      expect(modelContextLengthFromFields({ context_length: detected })).toBe(
        null,
      );
    },
  );

  it("uses Gemini and Claude API metadata instead of model-name tables", async function () {
    expect(
      await resolveModelContextLength({
        provider: "gemini",
        model: "models/gemini-future",
        detectedContextLength: 1_048_576,
      }),
    ).toEqual({
      contextLength: 1_048_576,
      contextLengthSource: "detected",
    });
    expect(
      await resolveModelContextLength({
        provider: "claude",
        model: "claude-future",
        detectedContextLength: 200_000,
      }),
    ).toEqual({
      contextLength: 200_000,
      contextLengthSource: "detected",
    });
  });

  it("distinguishes a pending compatible probe from unavailable native metadata", async function () {
    expect(
      resolveModelContextLengthWithoutDetection({
        provider: "openai-compatible",
      }),
    ).toEqual({
      contextLength: null,
      contextLengthSource: "pending",
    });
    expect(
      resolveModelContextLengthWithoutDetection({ provider: "azure" }),
    ).toEqual({
      contextLength: null,
      contextLengthSource: "unavailable",
    });
    expect(
      await resolveModelContextLength({
        provider: "gemini",
        model: "gemini-2.5-pro",
      }),
    ).toEqual({
      contextLength: null,
      contextLengthSource: "unavailable",
    });
    expect(
      await resolveModelContextLength({
        provider: "claude",
        model: "claude-sonnet-4-20250514",
      }),
    ).toEqual({
      contextLength: null,
      contextLengthSource: "unavailable",
    });
  });

  it("uses an OpenAI-compatible model-list value without probing", async function () {
    const detectOpenAiCompatibleContextLength = vi.fn(async () => 32_768);
    const input = {
      provider: "openai-compatible",
      baseUrl: "https://models.example.test/openai/v1",
      model: "hosted/reviewer",
      credential: "PRIVATE_CONTEXT_DETECTION_CREDENTIAL",
      contextLengthOverride: null,
      detectedContextLength: 131_072,
    };

    expect(
      await resolveModelContextLength(input, {
        detectOpenAiCompatibleContextLength,
      }),
    ).toEqual({
      contextLength: 131_072,
      contextLengthSource: "detected",
    });
    expect(detectOpenAiCompatibleContextLength).not.toHaveBeenCalled();
  });

  it("does not start vLLM runtime discovery when the model list has a value", async function () {
    const detectOpenAiCompatibleContextLength = vi.fn(async () => {
      throw new Error("PRIVATE_PROVIDER_FAILURE");
    });
    expect(
      await resolveModelContextLength(
        {
          provider: "openai-compatible",
          baseUrl: "http://127.0.0.1:8000/v1",
          model: "reviewer",
          detectedContextLength: 65_536,
        },
        {
          detectOpenAiCompatibleContextLength,
        },
      ),
    ).toEqual({
      contextLength: 65_536,
      contextLengthSource: "detected",
    });
    expect(detectOpenAiCompatibleContextLength).not.toHaveBeenCalled();
  });

  it("marks a failed compatible probe unavailable for that run", async function () {
    expect(
      await resolveModelContextLength(
        {
          provider: "openai-compatible",
          baseUrl: "http://127.0.0.1:1234/v1",
          model: "reviewer",
        },
        {
          detectOpenAiCompatibleContextLength: vi.fn(async () => {
            throw new Error("PRIVATE_CONTEXT_PROBE_FAILURE");
          }),
        },
      ),
    ).toEqual({
      contextLength: null,
      contextLengthSource: "unavailable",
    });
  });

  it("uses the advanced override without contacting the endpoint", async function () {
    const detectOpenAiCompatibleContextLength = vi.fn();
    expect(
      await resolveModelContextLength(
        {
          provider: "openai-compatible",
          baseUrl: "http://127.0.0.1:11434/v1",
          model: "qwen3.5:4b",
          contextLengthOverride: 65_536,
        },
        { detectOpenAiCompatibleContextLength },
      ),
    ).toEqual({
      contextLength: 65_536,
      contextLengthSource: "override",
    });
    expect(detectOpenAiCompatibleContextLength).not.toHaveBeenCalled();
  });
});
