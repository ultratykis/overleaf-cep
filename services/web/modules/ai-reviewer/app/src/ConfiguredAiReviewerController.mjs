// @ts-check

import { expressify } from "@overleaf/promise-utils";

import { AgentGatewayError } from "./AgentGateway.mjs";
import { createAiReviewerController } from "./AiReviewerController.mjs";

/** @import { AgentGateway } from '../../shared/contract-types' */
/** @typedef {() => AgentGateway} AgentGatewayFactory */

class UnconfiguredAgentGateway {
  async *stream() {
    yield* [];
    throw new AgentGatewayError("No AI provider is configured.", {
      code: "AI_PROVIDER_NOT_CONFIGURED",
      category: "configuration",
      retryable: false,
    });
  }
}

/** @type {AgentGatewayFactory} */
const unconfiguredGatewayFactory = () => new UnconfiguredAgentGateway();

/** @type {AgentGatewayFactory | null} */
let testGatewayFactory = null;

/**
 * Install an in-process fake only for acceptance and unit tests. There is no
 * setting, request field, or production code path that can select this
 * override.
 *
 * @param {AgentGatewayFactory} gatewayFactory
 * @returns {() => void}
 */
export function setAiReviewerGatewayFactoryForTests(gatewayFactory) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("The AI reviewer test gateway requires NODE_ENV=test.");
  }
  if (typeof gatewayFactory !== "function") {
    throw new TypeError("gatewayFactory must be a function.");
  }
  if (testGatewayFactory != null) {
    throw new Error("An AI reviewer test gateway is already installed.");
  }

  testGatewayFactory = gatewayFactory;
  let restored = false;
  return () => {
    if (restored) {
      return;
    }
    restored = true;
    if (testGatewayFactory === gatewayFactory) {
      testGatewayFactory = null;
    }
  };
}

const controller = createAiReviewerController({
  gatewayFactory: () => (testGatewayFactory ?? unconfiguredGatewayFactory)(),
});

export default {
  stream: expressify(controller.stream),
};
