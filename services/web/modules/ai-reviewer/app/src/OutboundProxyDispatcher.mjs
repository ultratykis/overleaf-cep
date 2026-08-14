// @ts-check

import { EnvHttpProxyAgent, Pool } from "undici";

import { createPinnedOpenAiCompatibleDispatcher } from "./OllamaOpenAiTransport.mjs";

const PROXY_ENVIRONMENT_VARIABLES = [
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
];

/**
 * @param {Parameters<typeof createPinnedOpenAiCompatibleDispatcher>[0]} options
 */
export function createOutboundProxyDispatcher(dispatcherOptions) {
  if (!PROXY_ENVIRONMENT_VARIABLES.some((name) => process.env[name])) {
    return createPinnedOpenAiCompatibleDispatcher(dispatcherOptions);
  }

  // DNS and connection pinning cannot cross a proxy. Skill imports remain
  // SSRF-safe because they construct only fixed Git-host URLs and retain
  // createGuardedOpenAiCompatibleFetch's exact allowedRequestUrl guard, so
  // arbitrary destinations cannot reach the administrator-configured proxy.
  // EnvHttpProxyAgent owns proxy/NO_PROXY parsing; direct requests stay pinned.
  return new EnvHttpProxyAgent({
    factory(origin, agentOptions) {
      const poolOptions = /** @type {import("undici").Pool.Options} */ (
        agentOptions
      );
      if (poolOptions.connect != null) {
        return new Pool(origin, poolOptions);
      }
      return createPinnedOpenAiCompatibleDispatcher(dispatcherOptions);
    },
  });
}
