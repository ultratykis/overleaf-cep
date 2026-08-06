import { describe, expect, it, vi } from "vitest";

import {
  AzureAiSdkTransport,
  OllamaOpenAiTransport,
} from "../../../app/src/OllamaOpenAiTransport.mjs";
import { deriveAiReviewerChatRequestUrl } from "../../../shared/provider-request-url.mjs";

const credential = "PRIVATE_REQUEST_URL_PARITY_CREDENTIAL";
const model = "gpt-5.6-terra";

const cases = [
  {
    name: "OpenAI-compatible",
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
  },
  {
    name: "OpenAI-compatible gateway API version",
    provider: "openai-compatible",
    baseUrl: "https://api.example.com/openai/v1",
    apiVersion: "2025-01-01-preview",
  },
  {
    name: "Azure v1",
    provider: "azure",
    baseUrl:
      "https://reviewer.openai.azure.com/openai/deployments/gpt-5.6-terra/chat/completions?api-version=2025-01-01-preview",
    requestStyle: "v1",
  },
  {
    name: "Azure deployment",
    provider: "azure",
    baseUrl:
      "https://reviewer.openai.azure.com/openai/deployments/gpt-5.6-terra/chat/completions?api-version=2025-01-01-preview",
    requestStyle: "deployment",
    apiVersion: "2025-01-01-preview",
  },
  {
    name: "Azure-compatible v1",
    provider: "azure",
    baseUrl: "https://azure-compatible.example/openai/v1",
    requestStyle: "v1",
  },
];

describe("AI reviewer: request URL preview parity", function () {
  it.each(cases)(
    "keeps the $name preview accepted by the transport guard",
    async function (testCase) {
      /** @type {typeof fetch | undefined} */
      let guardedFetch;
      const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));

      let previewUrl;
      if (testCase.provider === "openai-compatible") {
        new OllamaOpenAiTransport({
          baseUrl: testCase.baseUrl,
          apiVersion: testCase.apiVersion,
          ...(testCase.baseUrl.startsWith("https://") ? { credential } : {}),
          modelTag: model,
          fetchImpl,
          createProvider: vi.fn((options) => {
            guardedFetch = options.fetch;
            return {
              chatModel: () => ({
                specificationVersion: "v3",
                provider: "openai-compatible.chat",
                modelId: model,
                supportedUrls: {},
                doGenerate: vi.fn(),
                doStream: vi.fn(),
              }),
            };
          }),
        });
        previewUrl = deriveAiReviewerChatRequestUrl({
          provider: testCase.provider,
          baseUrl: testCase.baseUrl,
          apiVersion: testCase.apiVersion,
        });
      } else {
        new AzureAiSdkTransport({
          baseUrl: testCase.baseUrl,
          requestStyle: testCase.requestStyle,
          apiVersion: testCase.apiVersion,
          credential,
          modelTag: model,
          fetchImpl,
          createProvider: vi.fn((options) => {
            guardedFetch = options.fetch;
            return {
              chat: () => ({
                specificationVersion: "v4",
                provider: "azure.chat",
                modelId: model,
                supportedUrls: {},
                doGenerate: vi.fn(),
                doStream: vi.fn(),
              }),
            };
          }),
        });
        previewUrl = deriveAiReviewerChatRequestUrl({
          provider: testCase.provider,
          baseUrl: testCase.baseUrl,
          requestStyle: testCase.requestStyle,
          apiVersion: testCase.apiVersion,
          model,
        });
      }

      if (guardedFetch == null) {
        throw new Error("The transport did not expose its guarded fetch.");
      }
      await guardedFetch(previewUrl, { method: "POST" });

      expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
        previewUrl,
        expect.objectContaining({ method: "POST", redirect: "error" }),
      );
    },
  );
});
