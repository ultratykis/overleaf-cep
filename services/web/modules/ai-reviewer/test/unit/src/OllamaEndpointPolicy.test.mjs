import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertAllowedResolvedIpAddress,
  OPENAI_COMPATIBLE_FETCH_REDIRECT,
  OpenAiCompatibleEndpointPolicyError,
  parseOpenAiCompatibleBaseUrl,
  parseOpenAiCompatibleModelId,
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
const supersededRejections = [
  "https://127.0.0.1:11434/v1",
  "http://127.0.0.1:11434/api",
];

function expectedHost(input) {
  if (input.startsWith("http://[::1]:")) {
    return "[::1]";
  }
  return new URL(input).hostname;
}

function expectPolicyError(input) {
  expect(() => parseOpenAiCompatibleBaseUrl(input)).toThrowError(
    OpenAiCompatibleEndpointPolicyError,
  );
  try {
    parseOpenAiCompatibleBaseUrl(input);
  } catch (error) {
    expect(error).toMatchObject({
      code: "AI_OPENAI_COMPATIBLE_ENDPOINT_NOT_ALLOWED",
      category: "configuration",
      retryable: false,
    });
    expect(error.message).toBe(
      "The OpenAI-compatible endpoint is not allowed.",
    );
  }
}

describe("AI reviewer: OpenAI-compatible endpoint policy", function () {
  it("matches the frozen redirect policy", function () {
    expect(endpointPolicy.followRedirects).toBe(false);
    expect(OPENAI_COMPATIBLE_FETCH_REDIRECT).toBe("error");
  });

  it.each(endpointPolicy.accepted)(
    "accepts and preserves canonical local endpoint %s",
    function (input) {
      const parsed = parseOpenAiCompatibleBaseUrl(input);

      expect(parsed).toEqual({
        baseUrl: input,
        classification: "local",
        host: expectedHost(input),
        port: Number(new URL(input).port),
      });
      expect(Object.isFrozen(parsed)).toBe(true);
    },
  );

  it.each([
    {
      input: "https://api.example.com",
      host: "api.example.com",
      port: null,
      classification: "remote",
    },
    {
      input: "https://api.example.com/v1",
      host: "api.example.com",
      port: null,
      classification: "remote",
    },
    {
      input: "https://api.example.com:8443/api/v1",
      host: "api.example.com",
      port: 8443,
      classification: "remote",
    },
    {
      input: "https://10.0.0.1/tenant_1/~openai/v1.2",
      host: "10.0.0.1",
      port: null,
      classification: "remote",
    },
    {
      input: "https://[2001:db8::1]/api/v1",
      host: "[2001:db8::1]",
      port: null,
      classification: "remote",
    },
    {
      input: supersededRejections[0],
      host: "127.0.0.1",
      port: 11434,
      classification: "local",
    },
    {
      input: "https://localhost/v1",
      host: "localhost",
      port: null,
      classification: "local",
    },
    {
      input: "http://localhost:11434",
      host: "localhost",
      port: 11434,
      classification: "local",
    },
    {
      input: "http://host.docker.internal:11434/api/v1",
      host: "host.docker.internal",
      port: 11434,
      classification: "local",
    },
    {
      input: supersededRejections[1],
      host: "127.0.0.1",
      port: 11434,
      classification: "local",
    },
  ])(
    "accepts and preserves $input",
    function ({ input, host, port, classification }) {
      const parsed = parseOpenAiCompatibleBaseUrl(input);

      expect(parsed).toEqual({
        baseUrl: input,
        classification,
        host,
        port,
      });
      expect(Object.isFrozen(parsed)).toBe(true);
    },
  );

  it.each([1, 80, 32_768, 65_535])(
    "accepts explicit port boundary or interior value %i",
    function (port) {
      expect(
        parseOpenAiCompatibleBaseUrl(`http://localhost:${port}/v1`),
      ).toMatchObject({
        baseUrl: `http://localhost:${port}/v1`,
        classification: "local",
        host: "localhost",
        port,
      });
      expect(
        parseOpenAiCompatibleBaseUrl(`https://api.example.com:${port}/v1`),
      ).toMatchObject({
        baseUrl: `https://api.example.com:${port}/v1`,
        classification: "remote",
        host: "api.example.com",
        port,
      });
    },
  );

  it("identifies the fixture cases superseded by HTTPS and canonical paths", function () {
    expect(
      endpointPolicy.rejected.filter((input) =>
        supersededRejections.includes(input),
      ),
    ).toEqual(supersededRejections);
  });

  it.each(
    endpointPolicy.rejected.filter(
      (input) => !supersededRejections.includes(input),
    ),
  )("rejects carried-over disallowed endpoint %s", function (input) {
    expectPolicyError(input);
  });

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
  ])("fails closed for carried-over noncanonical input %#", function (input) {
    expectPolicyError(input);
  });

  it.each([
    "http://api.example.com:80/v1",
    "http://10.0.0.1:80/v1",
    "http://127.0.0.1/v1",
    "http://[::1]/v1",
    "http://host.docker.internal/v1",
    "https://169.254.0.0/v1",
    "https://169.254.169.254/v1",
    "https://169.254.255.255/v1",
    "https://[fe80::1]/v1",
    "https://[fe9f::1]/v1",
    "https://[fea0::1]/v1",
    "https://[febf::1]/v1",
    "https://metadata.google.internal/v1",
    "https://[::ffff:127.0.0.1]/v1",
    "https://[::ffff:7f00:1]/v1",
    "https://[0:0:0:0:0:ffff:7f00:1]/v1",
    "https://[::7f00:1]/v1",
    "https://[0:0:0:0:0:0:7f00:1]/v1",
  ])("rejects forbidden destination %s", function (input) {
    expectPolicyError(input);
  });

  it.each([
    "HTTPS://api.example.com/v1",
    "https://API.EXAMPLE.COM/v1",
    "https://api.example.com./v1",
    "https://api..example.com/v1",
    "https://-api.example.com/v1",
    "https://api-.example.com/v1",
    "https://2130706433/v1",
    "https://0177.0.0.1/v1",
    "https://127.1/v1",
    "https://0x7f000001/v1",
    "https://%31%32%37.0.0.1/v1",
    "https://user@api.example.com/v1",
    "https://api.example.com/v1?model=x",
    "https://api.example.com/v1#fragment",
    "https://api.example.com/v1/",
    "https://api.example.com/api//v1",
    "https://api.example.com/./v1",
    "https://api.example.com/api/../v1",
    "https://api.example.com/%76%31",
    "https://api.example.com/v1\n",
  ])("rejects HTTPS bypass form %s", function (input) {
    expectPolicyError(input);
  });
});

describe("AI reviewer: resolved OpenAI-compatible addresses", function () {
  it.each([
    "169.254.0.1",
    "169.254.169.254",
    "fe80::1",
    "febf:ffff::1",
    "fc00::1",
    "fd00:ec2::254",
    "::ffff:169.254.169.254",
  ])(
    "rejects forbidden resolved address %s without disclosing it",
    function (address) {
      let error;
      try {
        assertAllowedResolvedIpAddress(address);
      } catch (cause) {
        error = cause;
      }

      expect(error).toBeInstanceOf(OpenAiCompatibleEndpointPolicyError);
      expect(String(error)).not.toContain(address);
    },
  );

  it.each([
    "127.0.0.1",
    "::1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.50",
    "8.8.8.8",
    "2001:4860:4860::8888",
    "::ffff:192.168.1.50",
  ])("allows resolved address %s", function (address) {
    expect(() => assertAllowedResolvedIpAddress(address)).not.toThrow();
  });
});

describe("AI reviewer: OpenAI-compatible model identifiers", function () {
  it.each([
    "qwen3.5:4b",
    "hf.co/org/repo:Q4_K_M",
    "library/model.v1:latest",
    "gpt-4.1",
    "openai/gpt-4.1",
    "meta-llama/Llama-3.3-70B-Instruct",
  ])("accepts canonical model identifier %s", function (modelId) {
    expect(parseOpenAiCompatibleModelId(modelId)).toBe(modelId);
  });

  it.each([
    undefined,
    null,
    "",
    " qwen3.5:4b",
    "qwen3.5:4b ",
    "qwen3.5:",
    ":4b",
    "model/",
    "org//model",
    "qwen3.5:4b\n",
    "qwen3.5:4b?remote=true",
    "qwen3.5:4b#fragment",
  ])("rejects noncanonical model identifier %#", function (modelId) {
    expect(() => parseOpenAiCompatibleModelId(modelId)).toThrowError(
      "modelId must be a canonical OpenAI-compatible model identifier.",
    );
  });
});
