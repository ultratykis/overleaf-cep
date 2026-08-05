import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
  AiProviderConfigurationClientError,
  type AiProviderConfiguration,
  type AiProviderConfigurationWrite,
  type AiProviderConnection,
  createAiProviderConnection,
  deleteAiProviderConnection,
  getAiProviderConnections,
  getAiProviderModels,
  testAiProviderConnection,
  updateAiProviderConnection,
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
  contextLengthOverride: null,
  credentialSet: false,
  credentialUpdatedAt: null,
};
const otherConfiguration: AiProviderConfiguration = {
  provider: "openai-compatible",
  baseUrl: "https://api.example.com/v1",
  contextLengthOverride: null,
  credentialSet: true,
  credentialUpdatedAt,
};
const geminiConfiguration: AiProviderConfiguration = {
  provider: "gemini",
  contextLengthOverride: null,
  credentialSet: true,
  credentialUpdatedAt,
};
const claudeConfiguration: AiProviderConfiguration = {
  provider: "claude",
  contextLengthOverride: null,
  credentialSet: true,
  credentialUpdatedAt,
};
const connectionId = "connection-primary";
const secondConnectionId = "connection-secondary";
const unconfigured = null;
// The server derives a label from the endpoint when the user names none, so a
// listed connection always carries one.
const configured: AiProviderConnection = {
  id: connectionId,
  label: "127.0.0.1:11434",
  classification: "local",
  config: configuration,
};
const otherConfigured: AiProviderConnection = {
  id: connectionId,
  label: "api.example.com",
  classification: "remote",
  config: otherConfiguration,
};
const geminiConfigured: AiProviderConnection = {
  id: connectionId,
  label: "Google Gemini",
  classification: "remote",
  config: geminiConfiguration,
};
const claudeConfigured: AiProviderConnection = {
  id: secondConnectionId,
  label: "Anthropic Claude",
  classification: "remote",
  config: claudeConfiguration,
};
const configurationWrite: AiProviderConfigurationWrite = {
  provider: "openai-compatible",
  baseUrl: configuration.baseUrl,
  label: "",
  contextLengthOverride: null,
};
const otherConfigurationWrite: AiProviderConfigurationWrite = {
  provider: "openai-compatible",
  baseUrl: otherConfiguration.baseUrl,
  label: otherConfigured.label,
  contextLengthOverride: null,
};
const geminiConfigurationWrite: AiProviderConfigurationWrite = {
  provider: "gemini",
  label: "",
  contextLengthOverride: null,
};
const claudeConfigurationWrite: AiProviderConfigurationWrite = {
  provider: "claude",
  label: "",
  contextLengthOverride: null,
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
  modelCount: 2,
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

// The dialog speaks the connections API, but most cases still describe one
// connection. These adapters keep those cases expressed as a single saved
// connection instead of restating the listing shape everywhere.
function renderDetails({
  activeProjectId = projectId,
  getConfiguration = sinon.stub().resolves(unconfigured),
  saveConfiguration = sinon.stub().resolves(configured),
  deleteConnection = sinon.stub().resolves({ connections: [] }),
  testConnection = sinon.stub().resolves(connectionResponse),
} = {}) {
  const listConnections = sinon
    .stub()
    .callsFake(async (id: string, signal: AbortSignal) => {
      const connection = await getConfiguration(id, signal);
      return { connections: connection == null ? [] : [connection] };
    });
  const createConnection = sinon
    .stub()
    .callsFake(
      (id: string, config: AiProviderConfigurationWrite, signal: AbortSignal) =>
        saveConfiguration(id, config, signal),
    );
  const updateConnection = sinon
    .stub()
    .callsFake(
      (
        id: string,
        _connectionId: string,
        config: AiProviderConfigurationWrite,
        signal: AbortSignal,
      ) => saveConfiguration(id, config, signal),
    );
  const props = {
    onHide: sinon.stub(),
    listConnections,
    createConnection,
    updateConnection,
    deleteConnection,
    testConnection,
  };
  return {
    ...render(
      <AiIntegrationDetailsView projectId={activeProjectId} {...props} />,
    ),
    ...props,
    props,
    getConfiguration,
    saveConfiguration,
  };
}

// Cases about the listing itself drive the real props rather than the
// single-connection adapters above.
function renderConnections({
  listConnections = sinon.stub().resolves({ connections: [] }),
  createConnection = sinon.stub().resolves(configured),
  updateConnection = sinon.stub().resolves(configured),
  deleteConnection = sinon.stub().resolves({ connections: [] }),
  testConnection = sinon.stub().resolves(connectionResponse),
} = {}) {
  return render(
    <AiIntegrationDetailsView
      projectId={projectId}
      onHide={sinon.stub()}
      listConnections={listConnections}
      createConnection={createConnection}
      updateConnection={updateConnection}
      deleteConnection={deleteConnection}
      testConnection={testConnection}
    />,
  );
}

function connectionRows() {
  return screen.queryAllByTestId("ai-reviewer-connection-row");
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

  it("lists connections from the project-scoped GET route", async function () {
    const listing = { connections: [configured, claudeConfigured] };
    const route = fetchMock.get(
      `/project/${projectId}/ai-reviewer/connections`,
      listing,
    );
    const signal = new AbortController().signal;

    expect(await getAiProviderConnections(projectId, signal)).to.deep.equal(
      listing,
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

  it("creates a connection with exactly the four destination fields", async function () {
    const route = fetchMock.post(
      `/project/${projectId}/ai-reviewer/connections`,
      configured,
    );
    const signal = new AbortController().signal;
    const candidate = {
      ...configurationWrite,
      model: "must-not-be-sent",
      token: "must-not-be-sent",
    } as AiProviderConfigurationWrite;

    expect(
      await createAiProviderConnection(projectId, candidate, signal),
    ).to.deep.equal(configured);

    const call = route.callHistory.calls()[0];
    expect(call.options.method?.toUpperCase()).to.equal("POST");
    expect(call.options.signal).to.equal(signal);
    expect(Object.keys(JSON.parse(String(call.options.body)))).to.deep.equal([
      "provider",
      "baseUrl",
      "label",
      "contextLengthOverride",
    ]);
    expect(JSON.parse(String(call.options.body))).to.deep.equal(
      configurationWrite,
    );
  });

  it("deletes a connection through its own route", async function () {
    const remaining = { connections: [claudeConfigured] };
    const deleteRoute = fetchMock.delete(
      `/project/${projectId}/ai-reviewer/connections/${connectionId}`,
      remaining,
    );
    const signal = new AbortController().signal;

    expect(
      await deleteAiProviderConnection(projectId, connectionId, signal),
    ).to.deep.equal(remaining);

    const [removal] = deleteRoute.callHistory.calls();
    expect(removal.options.method?.toUpperCase()).to.equal("DELETE");
    expect(removal.options.body).to.equal(undefined);
  });

  it("sends only an explicitly entered credential as the fifth write field", async function () {
    const route = fetchMock.put(
      `/project/${projectId}/ai-reviewer/connections/${connectionId}`,
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
      await updateAiProviderConnection(
        projectId,
        connectionId,
        candidate,
        signal,
      ),
    ).to.deep.equal(otherConfigured);

    const call = route.callHistory.calls()[0];
    const body = JSON.parse(String(call.options.body));
    expect(Object.keys(body)).to.deep.equal([
      "provider",
      "baseUrl",
      "label",
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
      const route = fetchMock.post(
        `/project/${projectId}/ai-reviewer/connections`,
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
        await createAiProviderConnection(projectId, candidate, signal),
      ).to.deep.equal(native.response);

      const call = route.callHistory.calls()[0];
      const body = JSON.parse(String(call.options.body));
      expect(Object.keys(body)).to.deep.equal([
        "provider",
        "label",
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

  it("tests one saved connection through a POST that names it", async function () {
    const route = fetchMock.post(
      `/project/${projectId}/ai-reviewer/connection-test`,
      connectionResponse,
    );
    const signal = new AbortController().signal;

    expect(
      await testAiProviderConnection(projectId, connectionId, signal),
    ).to.deep.equal(connectionResponse);

    const call = route.callHistory.calls()[0];
    expect(call.options.method?.toUpperCase()).to.equal("POST");
    expect(call.options.signal).to.equal(signal);
    expect(JSON.parse(String(call.options.body))).to.deep.equal({
      connectionId,
    });
  });

  it("loads one model catalogue that already spans every connection", async function () {
    const catalog = {
      models: [
        {
          id: "qwen3.5:4b",
          displayName: "Qwen 3.5 4B",
          connectionId,
          connectionLabel: configured.label,
        },
        {
          id: "claude-sonnet-4-20250514",
          displayName: "Claude Sonnet",
          connectionId: secondConnectionId,
          connectionLabel: claudeConfigured.label,
        },
      ],
      failures: [],
    };
    const route = fetchMock.get(
      `/project/${projectId}/ai-reviewer/provider/models`,
      catalog,
    );
    const signal = new AbortController().signal;

    expect(await getAiProviderModels(projectId, signal)).to.deep.equal(catalog);
    const call = route.callHistory.calls()[0];
    expect(route.callHistory.calls()).to.have.length(1);
    expect(call.options.method?.toUpperCase()).to.equal("GET");
    expect(call.options.signal).to.equal(signal);
    expect(call.options.body).to.equal(undefined);
    expect(call.url).not.to.include("connectionId");
  });

  it("saves a connection without asking for a model and tests it afterwards", async function () {
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
    // A connection carries no model, so the dialog must not ask for one.
    expect(screen.queryByLabelText("Model")).not.to.exist;
    const openAiCompatibleApiKey = input("API key");
    expect(openAiCompatibleApiKey.required).to.equal(false);
    expect(openAiCompatibleApiKey.getAttribute("aria-required")).to.equal(
      "false",
    );
    fireEvent.change(input("Base URL"), {
      target: { value: configuration.baseUrl },
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

    fireEvent.click(button("Test connection"));
    await waitFor(() => expect(testConnection).to.have.been.calledOnce);
    expect(testConnection.firstCall.args).to.have.length(3);
    expect(testConnection.firstCall.args[0]).to.equal(projectId);
    await screen.findByText("Connection successful");
  });

  it("names a connection on request and hands the naming back to the server", async function () {
    const named: AiProviderConnection = {
      ...otherConfigured,
      label: "Lab GPU box",
    };
    const saveConfiguration = sinon.stub().resolves(named);
    renderDetails({
      getConfiguration: sinon.stub().resolves(otherConfigured),
      saveConfiguration,
    });
    await waitUntilLoaded();

    // A derived label is shown so the field always matches the listing.
    expect(input("Display name").value).to.equal(otherConfigured.label);
    fireEvent.change(input("Display name"), { target: { value: named.label } });
    fireEvent.click(button("Save"));

    await waitFor(() => expect(saveConfiguration).to.have.been.calledOnce);
    expect(saveConfiguration.firstCall.args[1]).to.deep.equal({
      ...otherConfigurationWrite,
      label: named.label,
    });

    await waitFor(() =>
      expect(input("Display name").value).to.equal("Lab GPU box"),
    );
    fireEvent.change(input("Display name"), { target: { value: "  " } });
    fireEvent.click(button("Save"));

    await waitFor(() => expect(saveConfiguration).to.have.been.calledTwice);
    expect(saveConfiguration.secondCall.args[1]).to.deep.equal({
      ...otherConfigurationWrite,
      label: "",
    });
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
      fireEvent.change(input("Display name"), {
        target: { value: "Renamed connection" },
      });
      expect(button("Save").disabled).to.equal(false);
      fireEvent.click(button("Save"));

      await waitFor(() => expect(saveConfiguration).to.have.been.calledOnce);
      expect(saveConfiguration.firstCall.args[1]).to.deep.equal({
        ...native.write,
        label: "Renamed connection",
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
        modelCount: 3,
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
      expect(testConnection.firstCall.args).to.have.length(3);
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
    } as AiProviderConnection;
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
    } as unknown as AiProviderConnection;
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

  it("saves a replacement credential and blanks its draft after the PUT response", async function () {
    const replacementResponse: AiProviderConnection = {
      ...otherConfigured,
      config: {
        ...otherConfiguration,
        credentialUpdatedAt: replacementCredentialUpdatedAt,
      },
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
    const overridden: AiProviderConnection = {
      ...otherConfigured,
      config: {
        ...otherConfiguration,
        contextLengthOverride: 65_536,
      },
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

  it("keeps Test disabled until the current draft is persisted", async function () {
    const pendingSave = deferred<AiProviderConnection>();
    const saveConfiguration = sinon.stub().returns(pendingSave.promise);
    renderDetails({
      getConfiguration: sinon.stub().resolves(configured),
      saveConfiguration,
    });
    await waitUntilLoaded();
    expect(button("Test connection").disabled).to.equal(false);

    fireEvent.change(input("Base URL"), {
      target: { value: otherConfiguration.baseUrl },
    });
    expect(button("Test connection").disabled).to.equal(true);
    fireEvent.click(button("Save"));
    expect(button("Test connection").disabled).to.equal(true);

    pendingSave.resolve(otherConfigured);
    await waitFor(() =>
      expect(button("Test connection").disabled).to.equal(false),
    );
    expect(input("Base URL").value).to.equal(otherConfiguration.baseUrl);
    expect(screen.getByText("Remote endpoint")).to.exist;
  });

  it("aborts and ignores a stale load after the project changes", async function () {
    const firstLoad = deferred<AiProviderConnection>();
    const getConfiguration = sinon.stub();
    getConfiguration.onFirstCall().returns(firstLoad.promise);
    getConfiguration.onSecondCall().resolves(otherConfigured);
    const rendered = renderDetails({ getConfiguration });

    await waitFor(() => expect(getConfiguration).to.have.been.calledOnce);
    const oldSignal = getConfiguration.firstCall.args[1] as AbortSignal;
    rendered.rerender(
      <AiIntegrationDetailsView
        projectId={otherProjectId}
        {...rendered.props}
      />,
    );

    await waitFor(() => expect(oldSignal.aborted).to.equal(true));
    await waitFor(() =>
      expect(input("Base URL").value).to.equal(otherConfiguration.baseUrl),
    );
    await act(async () => firstLoad.resolve(configured));
    expect(input("Base URL").value).to.equal(otherConfiguration.baseUrl);
    expect(screen.getByText("Remote endpoint")).to.exist;
  });

  it("aborts the active request when the view unmounts", async function () {
    const pendingLoad = deferred<AiProviderConnection>();
    const getConfiguration = sinon.stub().returns(pendingLoad.promise);
    const rendered = renderDetails({ getConfiguration });

    await waitFor(() => expect(getConfiguration).to.have.been.calledOnce);
    const signal = getConfiguration.firstCall.args[1] as AbortSignal;
    rendered.unmount();

    expect(signal.aborted).to.equal(true);
  });

  it("lists every registered connection by name and edits the one it is asked for", async function () {
    const listConnections = sinon
      .stub()
      .resolves({ connections: [otherConfigured, claudeConfigured] });
    renderConnections({ listConnections });
    await waitUntilLoaded();

    expect(connectionRows()).to.have.length(2);
    expect(
      connectionRows().map(
        (row) => within(row).getAllByRole("button")[0].textContent,
      ),
    ).to.deep.equal([otherConfigured.label, claudeConfigured.label]);
    // The first connection opens, because none is more default than another.
    expect(providerSelect().value).to.equal("openai-compatible");
    expect(input("Base URL").value).to.equal(otherConfiguration.baseUrl);

    fireEvent.click(
      within(connectionRows()[1]).getByRole("button", {
        name: claudeConfigured.label,
      }),
    );

    expect(providerSelect().value).to.equal("claude");
    expect(input("Display name").value).to.equal(claudeConfigured.label);
    expect(document.body.textContent).not.to.include(credential);
  });

  it("adds a second connection without disturbing the first", async function () {
    const listConnections = sinon
      .stub()
      .resolves({ connections: [otherConfigured] });
    const createConnection = sinon.stub().resolves(claudeConfigured);
    const updateConnection = sinon.stub().resolves(otherConfigured);
    renderConnections({ listConnections, createConnection, updateConnection });
    await waitUntilLoaded();
    expect(connectionRows()).to.have.length(1);

    fireEvent.click(button("Add connection"));
    expect(input("Display name").value).to.equal("");
    fireEvent.change(providerSelect(), { target: { value: "claude" } });
    fireEvent.change(input("API key"), { target: { value: credential } });
    fireEvent.click(button("Save"));

    await waitFor(() => expect(createConnection).to.have.been.calledOnce);
    expect(updateConnection).not.to.have.been.called;
    expect(createConnection.firstCall.args.slice(0, 2)).to.deep.equal([
      projectId,
      { ...claudeConfigurationWrite, credential },
    ]);
    await waitFor(() => expect(connectionRows()).to.have.length(2));
    expect(document.body.textContent).not.to.include(credential);
  });

  it("updates the selected connection through its own identifier", async function () {
    const listConnections = sinon
      .stub()
      .resolves({ connections: [claudeConfigured, otherConfigured] });
    const updateConnection = sinon.stub().resolves(claudeConfigured);
    renderConnections({ listConnections, updateConnection });
    await waitUntilLoaded();

    fireEvent.change(input("Display name"), {
      target: { value: "Renamed connection" },
    });
    fireEvent.click(button("Save"));

    await waitFor(() => expect(updateConnection).to.have.been.calledOnce);
    expect(updateConnection.firstCall.args.slice(0, 3)).to.deep.equal([
      projectId,
      secondConnectionId,
      {
        ...claudeConfigurationWrite,
        label: "Renamed connection",
      },
    ]);
  });

  it("deletes a connection and falls back to the one that is left", async function () {
    const listConnections = sinon
      .stub()
      .resolves({ connections: [claudeConfigured, otherConfigured] });
    const deleteConnection = sinon
      .stub()
      .resolves({ connections: [otherConfigured] });
    renderConnections({ listConnections, deleteConnection });
    await waitUntilLoaded();
    expect(providerSelect().value).to.equal("claude");

    fireEvent.click(
      within(connectionRows()[0]).getByRole("button", {
        name: "Delete connection",
      }),
    );

    await waitFor(() => expect(deleteConnection).to.have.been.calledOnce);
    expect(deleteConnection.firstCall.args.slice(0, 2)).to.deep.equal([
      projectId,
      secondConnectionId,
    ]);
    await waitFor(() => expect(connectionRows()).to.have.length(1));
    expect(providerSelect().value).to.equal("openai-compatible");
    expect(input("Base URL").value).to.equal(otherConfiguration.baseUrl);
  });

  it("reports a rejected eleventh connection without losing the draft", async function () {
    const listConnections = sinon
      .stub()
      .resolves({ connections: [otherConfigured] });
    const createConnection = sinon
      .stub()
      .rejects(
        new AiProviderConfigurationClientError(
          "AI_PROVIDER_CONNECTION_LIMIT_REACHED",
        ),
      );
    renderConnections({ listConnections, createConnection });
    await waitUntilLoaded();

    fireEvent.click(button("Add connection"));
    fireEvent.change(providerSelect(), { target: { value: "claude" } });
    fireEvent.change(input("Display name"), { target: { value: "Eleventh" } });
    fireEvent.change(input("API key"), { target: { value: credential } });
    fireEvent.click(button("Save"));

    await screen.findByText(
      "No more connections can be added. Delete one first.",
    );
    expect(input("Display name").value).to.equal("Eleventh");
    expect(connectionRows()).to.have.length(1);
  });

  it("shows a bounded non-2xx error without exposing the raw payload", async function () {
    fetchMock.get(`/project/${projectId}/ai-reviewer/connections`, {
      connections: [configured],
    });
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
    fetchMock.get(`/project/${projectId}/ai-reviewer/connections`, {
      connections: [],
    });
    fetchMock.post(`/project/${projectId}/ai-reviewer/connections`, {
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
    fetchMock.get(`/project/${projectId}/ai-reviewer/connections`, {
      connections: [otherConfigured],
    });
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
