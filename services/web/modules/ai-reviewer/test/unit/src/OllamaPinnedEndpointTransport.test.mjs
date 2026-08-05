import { describe, expect, it, vi } from "vitest";

import {
  createGuardedOpenAiCompatibleFetch,
  createNativeProviderFetch,
  createPinnedOpenAiCompatibleDispatcher,
} from "../../../app/src/OllamaOpenAiTransport.mjs";
import { OpenAiCompatibleEndpointPolicyError } from "../../../app/src/OllamaEndpointPolicy.mjs";

function pinnedFixture({
  addresses,
  hostname = "api.openai.com",
  peerAddress = addresses[0]?.address,
}) {
  let agentOptions;
  let buildOptions;
  let connectOptions;
  const socket = {
    destroy: vi.fn(),
    remoteAddress: peerAddress,
  };
  const lookupAll = vi.fn(async () => addresses);
  const connectorBuilder = vi.fn((options) => {
    buildOptions = options;
    return (optionsForConnection, callback) => {
      connectOptions = optionsForConnection;
      callback(null, socket);
    };
  });
  const dispatcher = createPinnedOpenAiCompatibleDispatcher({
    hostname,
    lookupAll,
    connectorBuilder,
    agentFactory(options) {
      agentOptions = options;
      return /** @type {never} */ ({ close: vi.fn() });
    },
  });

  async function connect() {
    return await new Promise((resolve) => {
      agentOptions.connect(
        {
          hostname,
          host: hostname,
          protocol: "https:",
          port: "443",
        },
        (error, connectedSocket) => resolve({ error, connectedSocket }),
      );
    });
  }

  return {
    buildOptions: () => buildOptions,
    connect,
    connectOptions: () => connectOptions,
    connectorBuilder,
    dispatcher,
    lookupAll,
    socket,
  };
}

describe("AI reviewer pinned OpenAI-compatible dispatcher", function () {
  it("does not resolve a hostname until the dispatcher connects", async function () {
    const fixture = pinnedFixture({
      addresses: [{ address: "93.184.216.34", family: 4 }],
    });

    await Promise.resolve();

    expect(fixture.lookupAll).not.toHaveBeenCalled();
    await fixture.connect();
    expect(fixture.lookupAll).toHaveBeenCalledOnce();
  });

  it.each(["169.254.169.254", "fd00:ec2::254", "::ffff:169.254.169.254"])(
    "rejects forbidden resolution %s before connecting",
    async function (address) {
      const fixture = pinnedFixture({
        addresses: [{ address, family: address.includes(":") ? 6 : 4 }],
      });

      const { error } = await fixture.connect();

      expect(error).toBeInstanceOf(OpenAiCompatibleEndpointPolicyError);
      expect(String(error)).not.toContain(address);
      expect(fixture.connectorBuilder).not.toHaveBeenCalled();
    },
  );

  it("rejects every mixed result when one resolved address is forbidden", async function () {
    const fixture = pinnedFixture({
      addresses: [
        { address: "93.184.216.34", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
    });

    const { error } = await fixture.connect();

    expect(error).toBeInstanceOf(OpenAiCompatibleEndpointPolicyError);
    expect(fixture.connectorBuilder).not.toHaveBeenCalled();
  });

  it("resolves once, pins the selected address, and fixes TLS servername", async function () {
    const fixture = pinnedFixture({
      addresses: [{ address: "93.184.216.34", family: 4 }],
    });

    const first = await fixture.connect();
    const second = await fixture.connect();
    const pinnedLookup = fixture.buildOptions().lookup;
    const lookupResult = await new Promise((resolve) => {
      pinnedLookup("api.openai.com", { all: true }, (_error, addresses) =>
        resolve(addresses),
      );
    });

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(fixture.lookupAll).toHaveBeenCalledOnce();
    expect(fixture.buildOptions()).toMatchObject({
      family: 4,
      servername: "api.openai.com",
    });
    expect(fixture.buildOptions()).not.toHaveProperty("rejectUnauthorized");
    expect(fixture.connectOptions()).toMatchObject({
      servername: "api.openai.com",
    });
    expect(lookupResult).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("interrupts a connection whose peer address differs from the pinned address", async function () {
    const fixture = pinnedFixture({
      addresses: [{ address: "93.184.216.34", family: 4 }],
      peerAddress: "93.184.216.35",
    });

    const { error, connectedSocket } = await fixture.connect();

    expect(error).toBeInstanceOf(Error);
    expect(connectedSocket).toBeNull();
    expect(fixture.socket.destroy).toHaveBeenCalledOnce();
    expect(String(error)).not.toContain("93.184.216");
  });

  it.each([
    ["localhost", "127.0.0.1", 4],
    ["127.0.0.1", "127.0.0.1", 4],
    ["::1", "::1", 6],
    ["ollama.internal", "192.168.1.50", 4],
  ])(
    "keeps allowed destination %s at %s connectable",
    async function (hostname, address, family) {
      const fixture = pinnedFixture({
        hostname,
        addresses: [{ address, family }],
      });

      const { error, connectedSocket } = await fixture.connect();

      expect(error).toBeNull();
      expect(connectedSocket).toBe(fixture.socket);
    },
  );

  it("injects the pinned dispatcher into the guarded fetch", async function () {
    const dispatcher = { close: vi.fn(async () => {}) };
    const dispatcherFactory = vi.fn(() => dispatcher);
    const fetchImpl = vi.fn(async () => new Response("{}"));
    const guardedFetch = createGuardedOpenAiCompatibleFetch({
      baseUrl: "https://api.openai.com/v1",
      allowedRequestUrl: "https://api.openai.com/v1/models",
      fetchImpl,
      lookupAll: vi.fn(),
      dispatcherFactory,
    });

    await guardedFetch("https://api.openai.com/v1/models");

    expect(dispatcherFactory).toHaveBeenCalledWith({
      hostname: "api.openai.com",
      lookupAll: expect.any(Function),
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://api.openai.com/v1/models", {
      redirect: "error",
      dispatcher,
    });
    expect(dispatcher.close).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "Gemini",
      "https://generativelanguage.googleapis.com/v1beta",
      "https://generativelanguage.googleapis.com/v1beta/models/test:generateContent",
      "generativelanguage.googleapis.com",
    ],
    [
      "Claude",
      "https://api.anthropic.com/v1",
      "https://api.anthropic.com/v1/messages",
      "api.anthropic.com",
    ],
  ])(
    "injects the same pinned dispatcher into the $name native fetch",
    async function (_name, baseUrl, requestUrl, hostname) {
      const dispatcher = { close: vi.fn(async () => {}) };
      const dispatcherFactory = vi.fn(() => dispatcher);
      const lookupAll = vi.fn();
      const fetchImpl = vi.fn(async () => new Response("{}"));
      const nativeFetch = createNativeProviderFetch({
        baseUrl,
        fetchImpl,
        lookupAll,
        dispatcherFactory,
      });

      await nativeFetch(requestUrl);

      expect(dispatcherFactory).toHaveBeenCalledExactlyOnceWith({
        hostname,
        lookupAll,
      });
      expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(requestUrl, {
        redirect: "error",
        dispatcher,
      });
      expect(dispatcher.close).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [
      "Gemini",
      "generativelanguage.googleapis.com",
      "https://generativelanguage.googleapis.com/v1beta",
      "https://generativelanguage.googleapis.com/v1beta/models/test:generateContent",
    ],
    [
      "Claude",
      "api.anthropic.com",
      "https://api.anthropic.com/v1",
      "https://api.anthropic.com/v1/messages",
    ],
  ])(
    "rejects a re-bound $name peer after native DNS pinning",
    async function (_name, hostname, baseUrl, requestUrl) {
      const fixture = pinnedFixture({
        hostname,
        addresses: [{ address: "93.184.216.34", family: 4 }],
        peerAddress: "93.184.216.35",
      });
      const nativeFetch = createNativeProviderFetch({
        baseUrl,
        fetchImpl: vi.fn(async () => {
          const { error } = await fixture.connect();
          throw new TypeError("fetch failed", { cause: error });
        }),
        dispatcherFactory: () => fixture.dispatcher,
      });

      let error;
      try {
        await nativeFetch(requestUrl);
      } catch (cause) {
        error = cause;
      }

      expect(error).toMatchObject({
        code: "AI_PROVIDER_NETWORK_FAILED",
        category: "network",
        retryable: true,
      });
      expect(fixture.lookupAll).toHaveBeenCalledOnce();
      expect(fixture.socket.destroy).toHaveBeenCalledOnce();
      expect(String(error)).not.toContain("93.184.216.34");
      expect(String(error)).not.toContain("93.184.216.35");
    },
  );

  it("returns the public policy error for a peer mismatch without disclosing either address", async function () {
    const fixture = pinnedFixture({
      addresses: [{ address: "93.184.216.34", family: 4 }],
      peerAddress: "93.184.216.35",
    });
    const guardedFetch = createGuardedOpenAiCompatibleFetch({
      baseUrl: "https://api.openai.com/v1",
      allowedRequestUrl: "https://api.openai.com/v1/models",
      fetchImpl: vi.fn(async () => {
        const { error } = await fixture.connect();
        throw new TypeError("fetch failed", { cause: error });
      }),
      dispatcherFactory: () => fixture.dispatcher,
    });
    let error;

    try {
      await guardedFetch("https://api.openai.com/v1/models");
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(OpenAiCompatibleEndpointPolicyError);
    expect(String(error)).not.toContain("93.184.216.34");
    expect(String(error)).not.toContain("93.184.216.35");
  });
});
