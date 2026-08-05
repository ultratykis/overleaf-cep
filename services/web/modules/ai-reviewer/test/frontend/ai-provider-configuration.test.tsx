import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect } from "chai";
import fetchMock from "fetch-mock";
import React from "react";
import sinon from "sinon";

import { ProjectProvider } from "@/shared/context/project-context";
import AiIntegrationDetails, {
  AiIntegrationDetailsView,
} from "../../frontend/js/components/ai-integration-details";
import {
  type AiProviderConfiguration,
  type AiProviderConfigurationResponse,
  type AiProviderConfigurationWrite,
  getAiProviderConfiguration,
  saveAiProviderConfiguration,
  testAiProviderConnection,
} from "../../frontend/js/services/ai-provider-configuration";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const projectId = "ai-provider-project";
const otherProjectId = "other-ai-provider-project";
const csrfToken = "synthetic-ai-provider-csrf";
const rawPayload = "RAW_PROVIDER_RESPONSE_dial_tcp_127_0_0_1_11434";
const credential = "PRIVATE_OPENAI_COMPATIBLE_CREDENTIAL";
const credentialUpdatedAt = "2026-07-26T01:02:03.000Z";
const replacementCredentialUpdatedAt = "2026-07-26T02:03:04.000Z";
const configuration: AiProviderConfiguration = {
  provider: "openai-compatible",
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "qwen3.5:4b",
  contextLength: 8_192,
  contextLengthSource: "detected",
  credentialSet: false,
  credentialUpdatedAt: null,
};
const otherConfiguration: AiProviderConfiguration = {
  provider: "openai-compatible",
  baseUrl: "https://api.example.com/v1",
  model: "hosted-model",
  contextLength: 4_096,
  contextLengthSource: "default",
  credentialSet: true,
  credentialUpdatedAt,
};
const configurationWrite: AiProviderConfigurationWrite = {
  provider: configuration.provider,
  baseUrl: configuration.baseUrl,
  model: configuration.model,
  contextLengthOverride: null,
};
const otherConfigurationWrite: AiProviderConfigurationWrite = {
  provider: otherConfiguration.provider,
  baseUrl: otherConfiguration.baseUrl,
  model: otherConfiguration.model,
  contextLengthOverride: null,
};
const geminiConfiguration: AiProviderConfiguration = {
  provider: "gemini",
  model: "gemini-2.5-pro",
  contextLength: 1_048_576,
  contextLengthSource: "derived",
  credentialSet: true,
  credentialUpdatedAt,
};
const claudeConfiguration: AiProviderConfiguration = {
  provider: "claude",
  model: "claude-sonnet-4-20250514",
  contextLength: 200_000,
  contextLengthSource: "derived",
  credentialSet: true,
  credentialUpdatedAt,
};
const geminiConfigurationWrite: AiProviderConfigurationWrite = {
  provider: geminiConfiguration.provider,
  model: geminiConfiguration.model,
  contextLengthOverride: null,
};
const claudeConfigurationWrite: AiProviderConfigurationWrite = {
  provider: claudeConfiguration.provider,
  model: claudeConfiguration.model,
  contextLengthOverride: null,
};
const unconfigured: AiProviderConfigurationResponse = {
  configured: false,
  config: null,
  classification: null,
};
const configured: AiProviderConfigurationResponse = {
  configured: true,
  config: configuration,
  classification: "local",
};
const otherConfigured: AiProviderConfigurationResponse = {
  configured: true,
  config: otherConfiguration,
  classification: "remote",
};
const geminiConfigured: AiProviderConfigurationResponse = {
  configured: true,
  config: geminiConfiguration,
  classification: "remote",
};
const claudeConfigured: AiProviderConfigurationResponse = {
  configured: true,
  config: claudeConfiguration,
  classification: "remote",
};
const nativeConfigurations = [
  {
    label: "Google Gemini",
    configuration: geminiConfiguration,
    write: geminiConfigurationWrite,
    response: geminiConfigured,
  },
  {
    label: "Anthropic Claude",
    configuration: claudeConfiguration,
    write: claudeConfigurationWrite,
    response: claudeConfigured,
  },
] as const;
const connectionResponse = {
  ok: true as const,
  provider: "openai-compatible" as const,
  model: configuration.model,
  classification: "local" as const,
};

let hadProjectId: boolean;
let previousProjectId: string | undefined;
let hadCsrfToken: boolean;
let previousCsrfToken: string | undefined;

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function button(name: string) {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function input(name: string) {
  return screen.getByLabelText(name) as HTMLInputElement;
}

function providerSelect() {
  return screen.getByRole("combobox", {
    name: "Provider",
  }) as HTMLSelectElement;
}

function renderDetails({
  activeProjectId = projectId,
  getConfiguration = sinon.stub().resolves(unconfigured),
  saveConfiguration = sinon.stub().resolves(configured),
  testConnection = sinon.stub().resolves(connectionResponse),
} = {}) {
  return {
    ...render(
      <AiIntegrationDetailsView
        projectId={activeProjectId}
        onHide={sinon.stub()}
        getConfiguration={getConfiguration}
        saveConfiguration={saveConfiguration}
        testConnection={testConnection}
      />,
    ),
    getConfiguration,
    saveConfiguration,
    testConnection,
  };
}

async function waitUntilLoaded() {
  await waitFor(() => expect(providerSelect().disabled).to.equal(false));
}

describe("AI reviewer: provider configuration", function () {
  beforeEach(function () {
    hadProjectId = window.metaAttributesCache.has("ol-project_id");
    previousProjectId = window.metaAttributesCache.get("ol-project_id");
    hadCsrfToken = window.metaAttributesCache.has("ol-csrfToken");
    previousCsrfToken = window.metaAttributesCache.get("ol-csrfToken");
    window.metaAttributesCache.set("ol-project_id", projectId);
    window.metaAttributesCache.set("ol-csrfToken", csrfToken);
  });

  afterEach(function () {
    cleanup();
    fetchMock.removeRoutes().clearHistory();
    sinon.restore();
    if (hadProjectId) {
      window.metaAttributesCache.set("ol-project_id", previousProjectId);
    } else {
      window.metaAttributesCache.delete("ol-project_id");
    }
    if (hadCsrfToken) {
      window.metaAttributesCache.set("ol-csrfToken", previousCsrfToken);
    } else {
      window.metaAttributesCache.delete("ol-csrfToken");
    }
  });

  it("loads configuration from the project-scoped GET route", async function () {
    const route = fetchMock.get(
      `/project/${projectId}/ai-reviewer/config`,
      unconfigured,
    );
    const signal = new AbortController().signal;

    expect(await getAiProviderConfiguration(projectId, signal)).to.deep.equal(
      unconfigured,
    );

    const call = route.callHistory.calls()[0];
    expect(route.callHistory.calls()).to.have.length(1);
    expect(call.options.method?.toUpperCase()).to.equal("GET");
    expect(call.options.signal).to.equal(signal);
    expect(call.options.body).to.equal(undefined);
    const headers = new Headers(call.options.headers);
    expect(headers.get("x-csrf-token")).to.equal(csrfToken);
    expect(headers.get("content-type")).to.equal("application/json");
  });

  it("saves exactly the four provider fields through PUT", async function () {
    const route = fetchMock.put(
      `/project/${projectId}/ai-reviewer/config`,
      configured,
    );
    const signal = new AbortController().signal;
    const candidate = {
      ...configurationWrite,
      contextLength: configuration.contextLength,
      contextLengthSource: configuration.contextLengthSource,
      token: "must-not-be-sent",
    } as AiProviderConfigurationWrite;

    expect(
      await saveAiProviderConfiguration(projectId, candidate, signal),
    ).to.deep.equal(configured);

    const call = route.callHistory.calls()[0];
    expect(call.options.method?.toUpperCase()).to.equal("PUT");
    expect(call.options.signal).to.equal(signal);
    expect(Object.keys(JSON.parse(String(call.options.body)))).to.deep.equal([
      "provider",
      "baseUrl",
      "model",
      "contextLengthOverride",
    ]);
    expect(JSON.parse(String(call.options.body))).to.deep.equal(
      configurationWrite,
    );
  });

  it("sends only an explicitly entered credential as the fifth PUT field", async function () {
    const route = fetchMock.put(
      `/project/${projectId}/ai-reviewer/config`,
      otherConfigured,
    );
    const signal = new AbortController().signal;
    const candidate = {
      ...otherConfigurationWrite,
      credential,
      token: "must-not-be-sent",
      credentialSet: true,
      credentialUpdatedAt,
    } as AiProviderConfigurationWrite;

    expect(
      await saveAiProviderConfiguration(projectId, candidate, signal),
    ).to.deep.equal(otherConfigured);

    const call = route.callHistory.calls()[0];
    const body = JSON.parse(String(call.options.body));
    expect(Object.keys(body)).to.deep.equal([
      "provider",
      "baseUrl",
      "model",
      "contextLengthOverride",
      "credential",
    ]);
    expect(body).to.deep.equal({
      ...otherConfigurationWrite,
      credential,
    });
    expect(JSON.stringify(body)).not.to.include("must-not-be-sent");
  });

  for (const native of nativeConfigurations) {
    it(`never serializes a base URL for ${native.label}`, async function () {
      const route = fetchMock.put(
        `/project/${projectId}/ai-reviewer/config`,
        native.response,
      );
      const signal = new AbortController().signal;
      const candidate = {
        ...native.write,
        credential,
        baseUrl: "https://must-not-be-sent.example/v1",
        token: "must-not-be-sent",
        credentialSet: true,
        credentialUpdatedAt,
      } as AiProviderConfigurationWrite;

      expect(
        await saveAiProviderConfiguration(projectId, candidate, signal),
      ).to.deep.equal(native.response);

      const call = route.callHistory.calls()[0];
      const body = JSON.parse(String(call.options.body));
      expect(Object.keys(body)).to.deep.equal([
        "provider",
        "model",
        "contextLengthOverride",
        "credential",
      ]);
      expect(body).to.deep.equal({
        ...native.write,
        credential,
      });
      expect(JSON.stringify(body)).not.to.include("must-not-be-sent");
      expect(body).not.to.have.property("baseUrl");
    });
  }

  it("tests persisted configuration through a bodyless POST", async function () {
    const route = fetchMock.post(
      `/project/${projectId}/ai-reviewer/connection-test`,
      connectionResponse,
    );
    const signal = new AbortController().signal;

    expect(await testAiProviderConnection(projectId, signal)).to.deep.equal(
      connectionResponse,
    );

    const call = route.callHistory.calls()[0];
    expect(call.options.method?.toUpperCase()).to.equal("POST");
    expect(call.options.signal).to.equal(signal);
    expect(call.options.body).to.equal(undefined);
  });

  it("loads, edits, saves, and tests a local configuration without a credential", async function () {
    const { saveConfiguration, testConnection } = renderDetails();
    await waitUntilLoaded();

    expect(providerSelect().value).to.equal("openai-compatible");
    const providerLabels = [...providerSelect().options].map(
      (option) => option.text,
    );
    expect(providerLabels).to.deep.equal([
      "OpenAI-compatible (Ollama, LM Studio, vLLM)",
      "Google Gemini",
      "Anthropic Claude",
    ]);
    expect(new Set(providerLabels).size).to.equal(providerLabels.length);
    expect(providerLabels[0]).to.include("Ollama");
    expect(providerLabels[0]).to.include("LM Studio");
    expect(providerLabels[0]).to.include("vLLM");
    for (const label of providerLabels) {
      expect(label).not.to.match(/^Provider\s*:/i);
    }
    const openAiCompatibleApiKey = input("API key");
    expect(openAiCompatibleApiKey.required).to.equal(false);
    expect(openAiCompatibleApiKey.getAttribute("aria-required")).to.equal(
      "false",
    );
    expect(document.body.textContent).not.to.include("API key (optional)");
    expect(document.body.textContent).not.to.include("API key (required)");
    fireEvent.change(input("Base URL"), {
      target: { value: configuration.baseUrl },
    });
    fireEvent.change(input("Model"), {
      target: { value: configuration.model },
    });
    expect(screen.queryByLabelText("Context length (tokens)")).not.to.exist;
    fireEvent.click(button("Save"));

    await waitFor(() => expect(saveConfiguration).to.have.been.calledOnce);
    expect(saveConfiguration.firstCall.args.slice(0, 2)).to.deep.equal([
      projectId,
      configurationWrite,
    ]);
    await screen.findByText("Local endpoint");
    await screen.findByText("No API key set");
    await screen.findByText("Context length in use: 8192 tokens");
    await screen.findByText("Detected from model metadata");

    fireEvent.click(button("Test connection"));
    await waitFor(() => expect(testConnection).to.have.been.calledOnce);
    expect(testConnection.firstCall.args).to.have.length(2);
    expect(testConnection.firstCall.args[0]).to.equal(projectId);
    await screen.findByText("Connection successful");
  });

  it("communicates API key requiredness through field state without changing the label", async function () {
    renderDetails();
    await waitUntilLoaded();

    const apiKeyInput = input("API key");
    expect(apiKeyInput.required).to.equal(false);
    expect(apiKeyInput.getAttribute("aria-required")).to.equal("false");

    for (const provider of ["gemini", "claude"]) {
      fireEvent.change(providerSelect(), { target: { value: provider } });
      expect(input("API key").required).to.equal(true);
      expect(input("API key").getAttribute("aria-required")).to.equal("true");
      expect(document.body.textContent).not.to.include("API key (required)");
      expect(document.body.textContent).not.to.include("API key (optional)");
    }

    fireEvent.change(providerSelect(), {
      target: { value: "openai-compatible" },
    });
    expect(input("API key").required).to.equal(false);
    expect(input("API key").getAttribute("aria-required")).to.equal("false");
  });

  for (const native of nativeConfigurations) {
    it(`requires a credential and hides the base URL when first saving ${native.label}`, async function () {
      const saveConfiguration = sinon.stub().resolves(native.response);
      renderDetails({ saveConfiguration });
      await waitUntilLoaded();

      fireEvent.change(providerSelect(), {
        target: { value: native.configuration.provider },
      });
      expect(screen.queryByLabelText("Base URL")).not.to.exist;
      fireEvent.change(input("Model"), {
        target: { value: native.configuration.model },
      });

      const apiKeyInput = input("API key");
      expect(apiKeyInput.value).to.equal("");
      expect(apiKeyInput.required).to.equal(true);
      expect(apiKeyInput.getAttribute("aria-required")).to.equal("true");
      expect(document.body.textContent).not.to.include("API key (required)");
      expect(button("Save").disabled).to.equal(true);
      fireEvent.change(apiKeyInput, {
        target: { value: credential },
      });
      expect(button("Save").disabled).to.equal(false);
      fireEvent.click(button("Save"));

      await waitFor(() => expect(saveConfiguration).to.have.been.calledOnce);
      expect(saveConfiguration.firstCall.args.slice(0, 2)).to.deep.equal([
        projectId,
        {
          ...native.write,
          credential,
        },
      ]);
      expect(saveConfiguration.firstCall.args[1]).not.to.have.property(
        "baseUrl",
      );
    });

    it(`reuses only the saved ${native.label} credential metadata`, async function () {
      const saveConfiguration = sinon.stub().resolves(native.response);
      renderDetails({
        getConfiguration: sinon.stub().resolves(native.response),
        saveConfiguration,
      });
      await waitUntilLoaded();

      expect(providerSelect().value).to.equal(native.configuration.provider);
      expect(screen.queryByLabelText("Base URL")).not.to.exist;
      const apiKeyInput = input("API key");
      expect(apiKeyInput.value).to.equal("");
      expect(apiKeyInput.required).to.equal(false);
      expect(apiKeyInput.getAttribute("aria-required")).to.equal("false");
      fireEvent.change(input("Model"), {
        target: { value: `${native.configuration.model}-replacement` },
      });
      expect(button("Save").disabled).to.equal(false);
      fireEvent.click(button("Save"));

      await waitFor(() => expect(saveConfiguration).to.have.been.calledOnce);
      expect(saveConfiguration.firstCall.args[1]).to.deep.equal({
        ...native.write,
        model: `${native.configuration.model}-replacement`,
      });
      expect(saveConfiguration.firstCall.args[1]).not.to.have.property(
        "credential",
      );
      expect(saveConfiguration.firstCall.args[1]).not.to.have.property(
        "baseUrl",
      );
    });

    it(`tests the persisted ${native.label} configuration`, async function () {
      const testConnection = sinon.stub().resolves({
        ok: true,
        provider: native.configuration.provider,
        model: native.configuration.model,
        classification: "remote",
      });
      renderDetails({
        getConfiguration: sinon.stub().resolves(native.response),
        testConnection,
      });
      await waitUntilLoaded();

      expect(button("Test connection").disabled).to.equal(false);
      fireEvent.click(button("Test connection"));

      await waitFor(() => expect(testConnection).to.have.been.calledOnce);
      expect(testConnection.firstCall.args).to.have.length(2);
      expect(testConnection.firstCall.args[0]).to.equal(projectId);
      await screen.findByText("Connection successful");
    });
  }

  it("does not reuse a credential after switching providers", async function () {
    renderDetails({
      getConfiguration: sinon.stub().resolves(otherConfigured),
    });
    await waitUntilLoaded();

    expect(screen.getByText("API key set")).to.exist;
    fireEvent.change(providerSelect(), { target: { value: "gemini" } });
    fireEvent.change(input("Model"), {
      target: { value: geminiConfiguration.model },
    });

    expect(screen.queryByLabelText("Base URL")).not.to.exist;
    const apiKeyInput = input("API key");
    expect(apiKeyInput.value).to.equal("");
    expect(apiKeyInput.required).to.equal(true);
    expect(apiKeyInput.getAttribute("aria-required")).to.equal("true");
    expect(button("Save").disabled).to.equal(true);
  });

  it("shows only remote credential metadata and never renders a returned secret", async function () {
    const responseWithSecret = {
      ...otherConfigured,
      config: {
        ...otherConfiguration,
        credential,
      },
    } as AiProviderConfigurationResponse;
    renderDetails({
      getConfiguration: sinon.stub().resolves(responseWithSecret),
    });

    await waitUntilLoaded();
    const credentialInput = input("API key");
    expect(credentialInput.type).to.equal("password");
    expect(credentialInput.value).to.equal("");
    expect(credentialInput.autocomplete).to.equal("new-password");
    expect(credentialInput.required).to.equal(false);
    expect(credentialInput.getAttribute("aria-required")).to.equal("false");
    expect(screen.getByText("Remote endpoint")).to.exist;
    expect(screen.getByText("API key set")).to.exist;
    expect(screen.getByText(`Last updated: ${credentialUpdatedAt}`)).to.exist;
    expect(document.body.textContent).not.to.include(credential);
  });

  it("reconstructs a native public configuration without returned secret fields", async function () {
    const responseWithSecrets = {
      ...geminiConfigured,
      config: {
        ...geminiConfiguration,
        baseUrl: "https://must-not-be-rendered.example/v1",
        credential,
      },
    } as unknown as AiProviderConfigurationResponse;
    renderDetails({
      getConfiguration: sinon.stub().resolves(responseWithSecrets),
    });

    await waitUntilLoaded();
    expect(providerSelect().value).to.equal("gemini");
    expect(screen.queryByLabelText("Base URL")).not.to.exist;
    const apiKeyInput = input("API key");
    expect(apiKeyInput.value).to.equal("");
    expect(apiKeyInput.required).to.equal(false);
    expect(apiKeyInput.getAttribute("aria-required")).to.equal("false");
    expect(screen.getByText("Remote endpoint")).to.exist;
    expect(screen.getByText("API key set")).to.exist;
    expect(screen.getByText(`Last updated: ${credentialUpdatedAt}`)).to.exist;
    expect(document.body.textContent).not.to.include(credential);
    expect(document.body.textContent).not.to.include(
      "must-not-be-rendered.example",
    );
  });

  for (const { source, response, value, sourceLabel } of [
    {
      source: "derived",
      response: geminiConfigured,
      value: geminiConfiguration.contextLength,
      sourceLabel: "Derived from the model",
    },
    {
      source: "detected",
      response: configured,
      value: configuration.contextLength,
      sourceLabel: "Detected from model metadata",
    },
    {
      source: "default",
      response: otherConfigured,
      value: otherConfiguration.contextLength,
      sourceLabel: "Conservative default",
    },
    {
      source: "override",
      response: {
        ...otherConfigured,
        config: {
          ...otherConfiguration,
          contextLength: 65_536,
          contextLengthSource: "override",
        },
      } satisfies AiProviderConfigurationResponse,
      value: 65_536,
      sourceLabel: "Advanced override",
    },
  ] as const) {
    it(`reports the effective context length and its ${source} source`, async function () {
      renderDetails({
        getConfiguration: sinon.stub().resolves(response),
      });
      await waitUntilLoaded();

      expect(screen.getByText(`Context length in use: ${value} tokens`)).to
        .exist;
      expect(screen.getByText(sourceLabel)).to.exist;
      const advanced = screen.getByText("Advanced settings").closest("details");
      expect(advanced?.open).to.equal(false);
      fireEvent.click(screen.getByText("Advanced settings"));
      expect(input("Context length override (tokens)").value).to.equal(
        source === "override" ? String(value) : "",
      );
    });
  }

  it("saves a replacement credential and blanks its draft after the PUT response", async function () {
    const replacementResponse: AiProviderConfigurationResponse = {
      configured: true,
      config: {
        ...otherConfiguration,
        credentialUpdatedAt: replacementCredentialUpdatedAt,
      },
      classification: "remote",
    };
    const saveConfiguration = sinon.stub().resolves(replacementResponse);
    renderDetails({
      getConfiguration: sinon.stub().resolves(otherConfigured),
      saveConfiguration,
    });
    await waitUntilLoaded();

    fireEvent.change(input("API key"), {
      target: { value: credential },
    });
    expect(button("Save").disabled).to.equal(false);
    expect(button("Test connection").disabled).to.equal(true);
    fireEvent.click(button("Save"));

    await waitFor(() => expect(saveConfiguration).to.have.been.calledOnce);
    expect(saveConfiguration.firstCall.args.slice(0, 2)).to.deep.equal([
      projectId,
      {
        ...otherConfigurationWrite,
        credential,
      },
    ]);
    await waitFor(() => expect(input("API key").value).to.equal(""));
    expect(button("Test connection").disabled).to.equal(false);
    expect(screen.getByText(`Last updated: ${replacementCredentialUpdatedAt}`))
      .to.exist;
  });

  it("keeps the optional context override in a closed advanced area and validates it", async function () {
    const { saveConfiguration } = renderDetails();
    await waitUntilLoaded();
    fireEvent.change(input("Base URL"), {
      target: { value: configuration.baseUrl },
    });
    fireEvent.change(input("Model"), {
      target: { value: configuration.model },
    });

    const advanced = screen.getByText("Advanced settings").closest("details");
    expect(advanced).not.to.equal(null);
    expect(advanced?.open).to.equal(false);
    fireEvent.click(screen.getByText("Advanced settings"));
    expect(advanced?.open).to.equal(true);
    expect(button("Save").disabled).to.equal(false);

    for (const value of ["0", "-1", "1.5"]) {
      fireEvent.change(input("Context length override (tokens)"), {
        target: { value },
      });
      expect(button("Save").disabled).to.equal(true);
    }

    fireEvent.change(input("Context length override (tokens)"), {
      target: { value: "65536" },
    });
    expect(button("Save").disabled).to.equal(false);
    fireEvent.click(button("Save"));
    await waitFor(() => expect(saveConfiguration).to.have.been.calledOnce);
    expect(saveConfiguration.firstCall.args[1]).to.deep.equal({
      ...configurationWrite,
      contextLengthOverride: 65_536,
    });
  });

  it("clears a saved advanced override with an explicit null write", async function () {
    const overridden: AiProviderConfigurationResponse = {
      configured: true,
      config: {
        ...otherConfiguration,
        contextLength: 65_536,
        contextLengthSource: "override",
      },
      classification: "remote",
    };
    const saveConfiguration = sinon.stub().resolves(otherConfigured);
    renderDetails({
      getConfiguration: sinon.stub().resolves(overridden),
      saveConfiguration,
    });
    await waitUntilLoaded();

    const advanced = screen.getByText("Advanced settings").closest("details");
    expect(advanced?.open).to.equal(false);
    fireEvent.click(screen.getByText("Advanced settings"));
    expect(input("Context length override (tokens)").value).to.equal("65536");
    fireEvent.change(input("Context length override (tokens)"), {
      target: { value: "" },
    });
    fireEvent.click(button("Save"));

    await waitFor(() => expect(saveConfiguration).to.have.been.calledOnce);
    expect(saveConfiguration.firstCall.args[1]).to.deep.equal({
      ...otherConfigurationWrite,
      contextLengthOverride: null,
    });
  });

  it("does not carry a saved override to a different model", async function () {
    const overridden: AiProviderConfigurationResponse = {
      configured: true,
      config: {
        ...otherConfiguration,
        contextLength: 65_536,
        contextLengthSource: "override",
      },
      classification: "remote",
    };
    const saveConfiguration = sinon.stub().resolves(otherConfigured);
    renderDetails({
      getConfiguration: sinon.stub().resolves(overridden),
      saveConfiguration,
    });
    await waitUntilLoaded();

    fireEvent.change(input("Model"), {
      target: { value: `${otherConfiguration.model}-replacement` },
    });
    fireEvent.click(button("Save"));

    await waitFor(() => expect(saveConfiguration).to.have.been.calledOnce);
    expect(saveConfiguration.firstCall.args[1]).to.deep.equal({
      ...otherConfigurationWrite,
      model: `${otherConfiguration.model}-replacement`,
      contextLengthOverride: null,
    });
  });

  it("keeps Test disabled until the current draft is persisted", async function () {
    const pendingSave = deferred<AiProviderConfigurationResponse>();
    const saveConfiguration = sinon.stub().returns(pendingSave.promise);
    renderDetails({
      getConfiguration: sinon.stub().resolves(configured),
      saveConfiguration,
    });
    await waitUntilLoaded();
    expect(button("Test connection").disabled).to.equal(false);

    fireEvent.change(input("Model"), {
      target: { value: otherConfiguration.model },
    });
    expect(button("Test connection").disabled).to.equal(true);
    fireEvent.click(button("Save"));
    expect(button("Test connection").disabled).to.equal(true);

    pendingSave.resolve(otherConfigured);
    await waitFor(() =>
      expect(button("Test connection").disabled).to.equal(false),
    );
    expect(input("Model").value).to.equal(otherConfiguration.model);
    expect(screen.getByText("Context length in use: 4096 tokens")).to.exist;
    expect(screen.getByText("Conservative default")).to.exist;
  });

  it("aborts and ignores a stale load after the project changes", async function () {
    const firstLoad = deferred<AiProviderConfigurationResponse>();
    const getConfiguration = sinon.stub();
    getConfiguration.onFirstCall().returns(firstLoad.promise);
    getConfiguration.onSecondCall().resolves(otherConfigured);
    const rendered = renderDetails({ getConfiguration });

    await waitFor(() => expect(getConfiguration).to.have.been.calledOnce);
    const oldSignal = getConfiguration.firstCall.args[1] as AbortSignal;
    rendered.rerender(
      <AiIntegrationDetailsView
        projectId={otherProjectId}
        onHide={sinon.stub()}
        getConfiguration={getConfiguration}
        saveConfiguration={rendered.saveConfiguration}
        testConnection={rendered.testConnection}
      />,
    );

    await waitFor(() => expect(oldSignal.aborted).to.equal(true));
    await waitFor(() =>
      expect(input("Model").value).to.equal(otherConfiguration.model),
    );
    await act(async () => firstLoad.resolve(configured));
    expect(input("Model").value).to.equal(otherConfiguration.model);
    expect(screen.getByText("Context length in use: 4096 tokens")).to.exist;
    expect(screen.getByText("Conservative default")).to.exist;
  });

  it("aborts the active request when the view unmounts", async function () {
    const pendingLoad = deferred<AiProviderConfigurationResponse>();
    const getConfiguration = sinon.stub().returns(pendingLoad.promise);
    const rendered = renderDetails({ getConfiguration });

    await waitFor(() => expect(getConfiguration).to.have.been.calledOnce);
    const signal = getConfiguration.firstCall.args[1] as AbortSignal;
    rendered.unmount();

    expect(signal.aborted).to.equal(true);
  });

  it("shows a bounded non-2xx error without exposing the raw payload", async function () {
    fetchMock.get(`/project/${projectId}/ai-reviewer/config`, configured);
    fetchMock.post(`/project/${projectId}/ai-reviewer/connection-test`, {
      status: 502,
      headers: { "Content-Type": "application/json" },
      body: {
        error: { code: "AI_PROVIDER_NETWORK_FAILED" },
        providerPayload: rawPayload,
      },
    });

    render(
      <ProjectProvider>
        <AiIntegrationDetails onHide={sinon.stub()} />
      </ProjectProvider>,
    );
    await waitUntilLoaded();
    fireEvent.click(button("Test connection"));

    await screen.findByText(
      "The AI provider could not be reached. Check the provider settings and network connection, then try again.",
    );
    expect(document.body.textContent).not.to.include(rawPayload);
  });

  it("routes a configuration persistence failure to server-storage guidance", async function () {
    const storageSentinel =
      "EACCES_/var/lib/overleaf/data/.token-cipher.json_PRIVATE_CREDENTIAL";
    fetchMock.get(`/project/${projectId}/ai-reviewer/config`, unconfigured);
    fetchMock.put(`/project/${projectId}/ai-reviewer/config`, {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: {
        error: {
          code: "AI_PROVIDER_CONFIGURATION_PERSISTENCE_FAILED",
          category: "configuration",
          message: storageSentinel,
          retryable: false,
        },
        serverPayload: storageSentinel,
      },
    });

    render(
      <ProjectProvider>
        <AiIntegrationDetails onHide={sinon.stub()} />
      </ProjectProvider>,
    );
    await waitUntilLoaded();
    fireEvent.change(input("Base URL"), {
      target: { value: configuration.baseUrl },
    });
    fireEvent.change(input("Model"), {
      target: { value: configuration.model },
    });
    fireEvent.click(button("Save"));

    await screen.findByText(
      "AI Reviewer could not save the provider configuration on this server. Ask the server administrator to check AI Reviewer storage and permissions, then try again.",
    );
    expect(document.body.textContent).not.to.include(storageSentinel);
    expect(document.body.textContent).not.to.include(
      "The AI provider request failed. Check the provider settings and try again.",
    );
  });

  it("preserves a bounded authentication category without exposing provider text", async function () {
    fetchMock.get(`/project/${projectId}/ai-reviewer/config`, otherConfigured);
    fetchMock.post(`/project/${projectId}/ai-reviewer/connection-test`, {
      status: 502,
      headers: { "Content-Type": "application/json" },
      body: {
        error: { code: "AI_PROVIDER_AUTHENTICATION_ERROR" },
        providerPayload: rawPayload,
      },
    });

    render(
      <ProjectProvider>
        <AiIntegrationDetails onHide={sinon.stub()} />
      </ProjectProvider>,
    );
    await waitUntilLoaded();
    fireEvent.click(button("Test connection"));

    await screen.findByText("The AI provider rejected its credentials.");
    expect(document.body.textContent).not.to.include(rawPayload);
    expect(document.body.textContent).not.to.include(credential);
  });
});
