import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MODEL_CONTEXT_LENGTH,
  deriveNativeModelContextLength,
  MAX_DETECTED_MODEL_CONTEXT_LENGTH,
  resolveModelContextLength,
} from "../../../app/src/ModelContextLength.mjs";

describe("AI reviewer model context length", function () {
  it("derives the Gemini context length from an explicit text-model entry", async function () {
    expect(deriveNativeModelContextLength("gemini", "gemini-2.5-pro")).toBe(
      1_048_576,
    );
    expect(
      await resolveModelContextLength({
        provider: "gemini",
        model: "models/gemini-2.5-pro",
        contextLengthOverride: null,
      }),
    ).toEqual({
      contextLength: 1_048_576,
      contextLengthSource: "derived",
    });
  });

  it("derives the Claude context length from its known model family", async function () {
    expect(
      deriveNativeModelContextLength("claude", "claude-sonnet-4-20250514"),
    ).toBe(200_000);
    expect(
      await resolveModelContextLength({
        provider: "claude",
        model: "claude-sonnet-4-20250514",
        contextLengthOverride: null,
      }),
    ).toEqual({
      contextLength: 200_000,
      contextLengthSource: "derived",
    });
  });

  it("does not overstate a specialised Gemini model through a broad prefix", async function () {
    expect(
      await resolveModelContextLength({
        provider: "gemini",
        model: "gemini-2.5-pro-preview-tts",
        contextLengthOverride: null,
      }),
    ).toEqual({
      contextLength: DEFAULT_MODEL_CONTEXT_LENGTH,
      contextLengthSource: "default",
    });
  });

  it("uses the conservative default for an unknown Claude model", async function () {
    expect(
      await resolveModelContextLength({
        provider: "claude",
        model: "claude-unknown-future-model",
      }),
    ).toEqual({
      contextLength: 4_096,
      contextLengthSource: "default",
    });
  });

  it("uses a valid OpenAI-compatible detection result", async function () {
    const detectOpenAiCompatibleContextLength = vi.fn(async () => 32_768);
    const input = {
      provider: "openai-compatible",
      baseUrl: "https://models.example.test/openai/v1",
      model: "hosted/reviewer",
      credential: "PRIVATE_CONTEXT_DETECTION_CREDENTIAL",
      contextLengthOverride: null,
    };

    expect(
      await resolveModelContextLength(input, {
        detectOpenAiCompatibleContextLength,
      }),
    ).toEqual({
      contextLength: 32_768,
      contextLengthSource: "detected",
    });
    expect(detectOpenAiCompatibleContextLength).toHaveBeenCalledExactlyOnceWith(
      {
        baseUrl: input.baseUrl,
        model: input.model,
        credential: input.credential,
      },
    );
  });

  it("falls back when OpenAI-compatible detection fails", async function () {
    expect(
      await resolveModelContextLength(
        {
          provider: "openai-compatible",
          baseUrl: "http://127.0.0.1:11434/v1",
          model: "qwen3.5:4b",
          contextLengthOverride: null,
        },
        {
          detectOpenAiCompatibleContextLength: vi.fn(async () => {
            throw new Error("PRIVATE_PROVIDER_FAILURE");
          }),
        },
      ),
    ).toEqual({
      contextLength: DEFAULT_MODEL_CONTEXT_LENGTH,
      contextLengthSource: "default",
    });
  });

  it.each([0, -1, 1.5, "32768", MAX_DETECTED_MODEL_CONTEXT_LENGTH + 1])(
    "falls back instead of trusting unusable detection value %j",
    async function (detected) {
      expect(
        await resolveModelContextLength(
          {
            provider: "openai-compatible",
            baseUrl: "http://127.0.0.1:11434/v1",
            model: "qwen3.5:4b",
          },
          {
            detectOpenAiCompatibleContextLength: vi.fn(async () => detected),
          },
        ),
      ).toEqual({
        contextLength: DEFAULT_MODEL_CONTEXT_LENGTH,
        contextLengthSource: "default",
      });
    },
  );

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
