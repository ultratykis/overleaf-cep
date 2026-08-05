import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  OLLAMA_FETCH_REDIRECT,
  OllamaEndpointPolicyError,
  parseOllamaOpenAiBaseUrl,
} from "../../../app/src/OllamaEndpointPolicy.mjs";

const fixtureDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/ollama",
);
const profile = JSON.parse(
  fs.readFileSync(path.join(fixtureDirectory, "m1-16gb-orbstack-v1.json"), {
    encoding: "utf8",
  }),
);
const endpointPolicy = profile.endpointPolicy;

function expectedHost(input) {
  if (input.startsWith("http://[::1]:")) {
    return "[::1]";
  }
  return new URL(input).hostname;
}

describe("AI reviewer: Ollama endpoint policy", function () {
  it("matches the frozen redirect policy", function () {
    expect(endpointPolicy.followRedirects).toBe(false);
    expect(OLLAMA_FETCH_REDIRECT).toBe("error");
  });

  it.each(endpointPolicy.accepted)(
    "accepts and preserves canonical local endpoint %s",
    function (input) {
      const parsed = parseOllamaOpenAiBaseUrl(input);

      expect(parsed).toEqual({
        baseUrl: input,
        classification: "local",
        host: expectedHost(input),
        port: Number(new URL(input).port),
      });
      expect(Object.isFrozen(parsed)).toBe(true);
    },
  );

  it.each([1, 80, 32_768, 65_535])(
    "accepts explicit port boundary or interior value %i",
    function (port) {
      expect(
        parseOllamaOpenAiBaseUrl(`http://localhost:${port}/v1`),
      ).toMatchObject({
        baseUrl: `http://localhost:${port}/v1`,
        classification: "local",
        host: "localhost",
        port,
      });
    },
  );

  it.each(endpointPolicy.rejected)(
    "rejects frozen disallowed endpoint %s",
    function (input) {
      expect(() => parseOllamaOpenAiBaseUrl(input)).toThrowError(
        OllamaEndpointPolicyError,
      );
      try {
        parseOllamaOpenAiBaseUrl(input);
      } catch (error) {
        expect(error).toMatchObject({
          code: "AI_OLLAMA_ENDPOINT_NOT_ALLOWED",
          category: "configuration",
          retryable: false,
        });
        expect(error.message).toBe(
          "The Ollama endpoint is not an allowed local OpenAI-compatible URL.",
        );
      }
    },
  );

  it.each([
    undefined,
    null,
    11434,
    "",
    " http://127.0.0.1:11434/v1",
    "http://127.0.0.1:11434/v1 ",
    "HTTP://127.0.0.1:11434/v1",
    "http://LOCALHOST:11434/v1",
    "http://localhost.:11434/v1",
    "http://localhost:011434/v1",
    "http://localhost:80/v1/",
    "http://localhost:80/api/../v1",
    "http://localhost:80/%76%31",
    "http://localhost:80/v1\n",
  ])("fails closed for noncanonical input %#", function (input) {
    expect(() => parseOllamaOpenAiBaseUrl(input)).toThrowError(
      OllamaEndpointPolicyError,
    );
  });
});
