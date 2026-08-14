import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent, EnvHttpProxyAgent, request } from "undici";

import { createAiReviewerSkillGitImporter } from "../../../app/src/AiReviewerSkillGitImporter.mjs";
import { OpenAiCompatibleEndpointPolicyError } from "../../../app/src/OllamaEndpointPolicy.mjs";
import { createGuardedOpenAiCompatibleFetch } from "../../../app/src/OllamaOpenAiTransport.mjs";
import { createOutboundProxyDispatcher } from "../../../app/src/OutboundProxyDispatcher.mjs";

const PROXY_ENVIRONMENT_VARIABLES = [
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "no_proxy",
  "NO_PROXY",
];

function clearProxyEnvironment() {
  for (const name of PROXY_ENVIRONMENT_VARIABLES) vi.stubEnv(name, undefined);
}

function enableProxyEnvironment() {
  vi.stubEnv("HTTP_PROXY", "http://proxy.example:8080");
  vi.stubEnv("HTTPS_PROXY", "http://proxy.example:8080");
}

afterEach(function () {
  vi.unstubAllEnvs();
});

describe("AI reviewer outbound proxy dispatcher", function () {
  it("uses EnvHttpProxyAgent for git imports when proxy environment variables are set", async function () {
    clearProxyEnvironment();
    enableProxyEnvironment();
    let dispatcher;
    const importer = createAiReviewerSkillGitImporter({
      fetchImpl: vi.fn(async (_url, init) => {
        dispatcher = init.dispatcher;
        return new Response(null, { status: 502 });
      }),
      timeoutSignal: () => new AbortController().signal,
    });

    await expect(
      importer.preview({ repository: "owner/repository" }),
    ).rejects.toBeDefined();

    expect(dispatcher).toBeInstanceOf(EnvHttpProxyAgent);
  });

  it("keeps the pinned dispatcher when proxy environment variables are unset", async function () {
    clearProxyEnvironment();
    const dispatcher = createOutboundProxyDispatcher({
      hostname: "api.github.com",
      lookupAll: vi.fn(),
    });

    expect(dispatcher).toBeInstanceOf(Agent);
    expect(dispatcher).not.toBeInstanceOf(EnvHttpProxyAgent);
    await dispatcher.close();
  });

  it("keeps the pinned route when NO_PROXY contains the target host", async function () {
    clearProxyEnvironment();
    enableProxyEnvironment();
    vi.stubEnv("NO_PROXY", "api.github.com");
    const lookupAll = vi.fn(async () => {
      throw new Error("pinned lookup reached");
    });
    const dispatcher = createOutboundProxyDispatcher({
      hostname: "api.github.com",
      lookupAll,
    });

    try {
      await expect(
        request("https://api.github.com/repos/owner/repository", {
          dispatcher,
        }),
      ).rejects.toBeDefined();
      expect(lookupAll).toHaveBeenCalledOnce();
    } finally {
      await dispatcher.close();
    }
  });

  it("retains the allowed request URL guard when proxying", async function () {
    clearProxyEnvironment();
    enableProxyEnvironment();
    const fetchImpl = vi.fn();
    const guardedFetch = createGuardedOpenAiCompatibleFetch({
      baseUrl: "https://api.github.com/",
      allowedRequestUrl: "https://api.github.com/repos/owner/repository",
      fetchImpl,
      dispatcherFactory: createOutboundProxyDispatcher,
    });

    await expect(
      guardedFetch("https://example.com/repos/owner/repository"),
    ).rejects.toBeInstanceOf(OpenAiCompatibleEndpointPolicyError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["gateway", "https://gateway.example/v1"],
    ["Ollama", "http://127.0.0.1:11434/v1"],
  ])(
    "does not leak proxy environment variables into the %s request path",
    async function (_name, baseUrl) {
      async function captureDispatcher() {
        let dispatcher;
        const requestUrl = `${baseUrl}/models`;
        const guardedFetch = createGuardedOpenAiCompatibleFetch({
          baseUrl,
          allowedRequestUrl: requestUrl,
          fetchImpl: vi.fn(async (_url, init) => {
            dispatcher = init.dispatcher;
            return new Response("{}");
          }),
        });
        await guardedFetch(requestUrl);
        return dispatcher;
      }

      clearProxyEnvironment();
      const withoutProxy = await captureDispatcher();
      enableProxyEnvironment();
      const withProxy = await captureDispatcher();

      expect(withoutProxy).toBeInstanceOf(Agent);
      expect(withProxy).toBeInstanceOf(Agent);
      expect(withProxy).not.toBeInstanceOf(EnvHttpProxyAgent);
    },
  );
});
