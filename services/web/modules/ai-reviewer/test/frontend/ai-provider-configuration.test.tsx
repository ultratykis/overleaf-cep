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
  type AiProviderConfiguration,
  type AiProviderConfigurationWrite,
  type AiProviderConnection,
  createAiProviderConnection,
  createUserAiProviderConnection,
  deleteAiProviderConnection,
  deleteUserAiProviderConnection,
  getAiProviderConnections,
  getAiProviderModels,
  getUserAiProviderConnections,
  testAiProviderConnection,
  updateAiProviderConnection,
  updateUserAiProviderConnection,
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
const azureBaseUrl = "https://reviewer.openai.azure.com/openai";
const plaintextAzureBaseUrl = "http://host.docker.internal:11434/openai";
const azureApiVersion = "2025-01-01-preview";
const azureDeployment = "gpt-5.6-terra";
const azurePortalEndpoint = `${azureBaseUrl}/deployments/${azureDeployment}/chat/completions?api-version=${azureApiVersion}`;
const azureConfiguration: AiProviderConfiguration = {
  provider: "azure",
  baseUrl: azureBaseUrl,
  requestStyle: "deployment",
  apiVersion: azureApiVersion,
  deployments: [azureDeployment],
  contextLengthOverrides: [],
  contextLengthOverride: null,
  credentialSet: true,
  credentialUpdatedAt,
};
const v1AzureConfiguration: AiProviderConfiguration = {
  provider: "azure",
  baseUrl: azureBaseUrl,
  requestStyle: "v1",
  deployments: [azureDeployment],
  contextLengthOverrides: [],
  contextLengthOverride: null,
  credentialSet: true,
  credentialUpdatedAt,
};
const blankAzureConfiguration: AiProviderConfiguration = {
  provider: "azure",
  baseUrl: azureBaseUrl,
  requestStyle: "deployment",
  deployments: [azureDeployment],
  contextLengthOverrides: [],
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
  revision: 1,
  label: "127.0.0.1:11434",
  classification: "local",
  config: configuration,
};
const otherConfigured: AiProviderConnection = {
  id: connectionId,
  revision: 2,
  label: "api.example.com",
  classification: "remote",
  config: otherConfiguration,
};
const geminiConfigured: AiProviderConnection = {
  id: connectionId,
  revision: 1,
  label: "Google Gemini",
  classification: "remote",
  config: geminiConfiguration,
};
const claudeConfigured: AiProviderConnection = {
  id: secondConnectionId,
  revision: 1,
  label: "Anthropic Claude",
  classification: "remote",
  config: claudeConfiguration,
};
const azureConfigured: AiProviderConnection = {
  id: connectionId,
  revision: 1,
  label: "reviewer.openai.azure.com",
  classification: "remote",
  config: azureConfiguration,
};
const v1AzureConfigured: AiProviderConnection = {
  ...azureConfigured,
  config: v1AzureConfiguration,
};
const blankAzureConfigured: AiProviderConnection = {
  ...azureConfigured,
  config: blankAzureConfiguration,
};
const configurationWrite: AiProviderConfigurationWrite = {
  provider: "openai-compatible",
  baseUrl: configuration.baseUrl,
  models: [],
  label: "",
  contextLengthOverride: null,
};
const otherConfigurationWrite: AiProviderConfigurationWrite = {
  provider: "openai-compatible",
  baseUrl: otherConfiguration.baseUrl,
  models: [],
  label: otherConfigured.label,
  contextLengthOverride: null,
};
const geminiConfigurationWrite: AiProviderConfigurationWrite = {
  provider: "gemini",
  models: [],
  label: "",
  contextLengthOverride: null,
};
const claudeConfigurationWrite: AiProviderConfigurationWrite = {
  provider: "claude",
  models: [],
  label: "",
  contextLengthOverride: null,
};
const azureConfigurationWrite: AiProviderConfigurationWrite = {
  provider: "azure",
  baseUrl: azurePortalEndpoint,
  requestStyle: "deployment",
  apiVersion: azureApiVersion,
  deployments: [azureDeployment],
  contextLengthOverrides: [],
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

function requestStyleSelect() {
  return screen.getByRole("combobox", {
    name: "Request style",
  }) as HTMLSelectElement;
}

function requestUrlValues() {
  return [
    ...document.querySelectorAll(".ai-reviewer-provider-request-url"),
  ].map((element) => element.textContent);
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
        _expectedRevision: number,
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
    listSkills: sinon.stub().resolves({ skills: [] }),
    uploadSkill: sinon.stub(),
    previewSkillGitImport: sinon.stub(),
    confirmSkillGitImport: sinon.stub(),
    deleteSkill: sinon.stub(),
  };
  return {
    ...render(
      <AiIntegrationDetailsView scopeKey={activeProjectId} {...props} />,
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
  onHide = sinon.stub(),
  listConnections = sinon.stub().resolves({ connections: [] }),
  createConnection = sinon.stub().resolves(configured),
  updateConnection = sinon.stub().resolves(configured),
  deleteConnection = sinon.stub().resolves({ connections: [] }),
  testConnection = sinon.stub().resolves(connectionResponse),
  listSkills = sinon.stub().resolves({ skills: [] }),
  uploadSkill = sinon.stub(),
  previewSkillGitImport = sinon.stub(),
  confirmSkillGitImport = sinon.stub(),
  deleteSkill = sinon.stub(),
} = {}) {
  return render(
    <AiIntegrationDetailsView
      scopeKey={projectId}
      onHide={onHide}
      listConnections={listConnections}
      createConnection={createConnection}
      updateConnection={updateConnection}
      deleteConnection={deleteConnection}
      testConnection={testConnection}
      listSkills={listSkills}
      uploadSkill={uploadSkill}
      previewSkillGitImport={previewSkillGitImport}
      confirmSkillGitImport={confirmSkillGitImport}
      deleteSkill={deleteSkill}
    />,
  );
}

function connectionRows() {
  return screen.queryAllByTestId("ai-reviewer-connection-row");
}

function editConnection(connection: AiProviderConnection) {
  fireEvent.click(button(`Edit ${connection.label}`));
}

function testConnectionButton(connection: AiProviderConnection) {
  return button(`Test ${connection.label}`);
}

function deleteConnectionButton(connection: AiProviderConnection) {
  return button(`Delete ${connection.label}`);
}

function closeSettingsButton() {
  return within(document.querySelector(".modal-footer")!).getByRole("button", {
    name: "Close",
  });
}

function credentialUpdateTime(updatedAt: string) {
  return screen.getByTitle(updatedAt) as HTMLTimeElement;
}

async function waitUntilLoaded({ openEmptyForm = true } = {}) {
  await waitFor(() =>
    expect(
      document.querySelector(".ai-reviewer-connection-footer"),
    ).not.to.equal(null),
  );
  if (openEmptyForm && connectionRows().length === 0) {
    fireEvent.click(button("Add connection"));
    await waitFor(() =>
      expect(
        document.querySelector(".ai-reviewer-provider-settings-form"),
      ).not.to.equal(null),
    );
  }
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

  it("uses the user-scoped connection CRUD routes without putting a user id in the URL", async function () {
    const scopeKey = "must-not-be-sent-as-a-user-id";
    const signal = new AbortController().signal;
    fetchMock.get("/user/ai-reviewer/connections", {
      connections: [configured],
    });
    fetchMock.post("/user/ai-reviewer/connections", configured);
    fetchMock.put(
      `/user/ai-reviewer/connections/${connectionId}`,
      otherConfigured,
    );
    fetchMock.delete(`/user/ai-reviewer/connections/${connectionId}`, {
      connections: [],
    });

    await getUserAiProviderConnections(scopeKey, signal);
    await createUserAiProviderConnection(scopeKey, configurationWrite, signal);
    await updateUserAiProviderConnection(
      scopeKey,
      connectionId,
      configured.revision,
      otherConfigurationWrite,
      signal,
    );
    await deleteUserAiProviderConnection(
      scopeKey,
      connectionId,
      configured.revision,
      signal,
    );

    expect(
      fetchMock.callHistory
        .calls()
        .map(({ url, options }) => [
          options.method?.toUpperCase(),
          new URL(url).pathname,
        ]),
    ).to.deep.equal([
      ["GET", "/user/ai-reviewer/connections"],
      ["POST", "/user/ai-reviewer/connections"],
      ["PUT", `/user/ai-reviewer/connections/${connectionId}`],
      ["DELETE", `/user/ai-reviewer/connections/${connectionId}`],
    ]);
    expect(
      fetchMock.callHistory.calls().map(({ url }) => new URL(url).pathname),
    ).not.to.include(scopeKey);
  });

  it("creates a connection with exactly the destination fields", async function () {
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
      "models",
      "label",
      "contextLengthOverride",
    ]);
    expect(JSON.parse(String(call.options.body))).to.deep.equal(
      configurationWrite,
    );
  });

  it("serializes reasoning model compatibility when enabled", async function () {
    const route = fetchMock.post(
      `/project/${projectId}/ai-reviewer/connections`,
      configured,
    );
    const candidate: AiProviderConfigurationWrite = {
      ...configurationWrite,
      reasoningModelCompatibility: true,
    };

    await createAiProviderConnection(
      projectId,
      candidate,
      new AbortController().signal,
    );

    expect(
      JSON.parse(String(route.callHistory.calls()[0].options.body)),
    ).to.deep.equal(candidate);
  });

  it("serializes only the Azure request style, endpoint, version, deployments, and common fields", async function () {
    const route = fetchMock.post(
      `/project/${projectId}/ai-reviewer/connections`,
      azureConfigured,
    );
    const signal = new AbortController().signal;
    const candidate = {
      ...azureConfigurationWrite,
      credential,
      model: "must-not-be-sent",
      token: "must-not-be-sent",
    } as AiProviderConfigurationWrite;

    expect(
      await createAiProviderConnection(projectId, candidate, signal),
    ).to.deep.equal(azureConfigured);

    const body = JSON.parse(String(route.callHistory.calls()[0].options.body));
    expect(Object.keys(body)).to.deep.equal([
      "provider",
      "baseUrl",
      "requestStyle",
      "apiVersion",
      "deployments",
      "contextLengthOverrides",
      "label",
      "contextLengthOverride",
      "credential",
    ]);
    expect(body).to.deep.equal({
      ...azureConfigurationWrite,
      credential,
    });
    expect(JSON.stringify(body)).not.to.include("must-not-be-sent");
  });

  it("deletes a connection through its own route", async function () {
    const remaining = { connections: [claudeConfigured] };
    const deleteRoute = fetchMock.delete(
      `/project/${projectId}/ai-reviewer/connections/${connectionId}`,
      remaining,
    );
    const signal = new AbortController().signal;

    expect(
      await deleteAiProviderConnection(
        projectId,
        connectionId,
        configured.revision,
        signal,
      ),
    ).to.deep.equal(remaining);

    const [removal] = deleteRoute.callHistory.calls();
    expect(removal.options.method?.toUpperCase()).to.equal("DELETE");
    expect(JSON.parse(String(removal.options.body))).to.deep.equal({
      expectedRevision: configured.revision,
    });
  });

  it("sends only an explicitly entered credential beyond the destination fields", async function () {
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
        configured.revision,
        candidate,
        signal,
      ),
    ).to.deep.equal(otherConfigured);

    const call = route.callHistory.calls()[0];
    const body = JSON.parse(String(call.options.body));
    expect(Object.keys(body)).to.deep.equal([
      "provider",
      "baseUrl",
      "models",
      "label",
      "contextLengthOverride",
      "credential",
      "expectedRevision",
    ]);
    expect(body).to.deep.equal({
      ...otherConfigurationWrite,
      credential,
      expectedRevision: configured.revision,
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
        "models",
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
          contextLength: 32_768,
          contextLengthSource: "detected",
        },
        {
          id: "claude-sonnet-4-20250514",
          displayName: "Claude Sonnet",
          connectionId: secondConnectionId,
          connectionLabel: claudeConfigured.label,
          contextLength: 200_000,
          contextLengthSource: "detected",
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
      "Azure OpenAI",
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
    await screen.findByText("OpenAI-compatible");
    await screen.findByText("No API key set");

    fireEvent.click(testConnectionButton(configured));
    await waitFor(() => expect(testConnection).to.have.been.calledOnce);
    expect(testConnection.firstCall.args).to.have.length(3);
    expect(testConnection.firstCall.args[0]).to.equal(projectId);
    await screen.findByText("Connection successful");
  });

  it("saves manual fallback model names with the connection", async function () {
    const { saveConfiguration } = renderDetails();
    await waitUntilLoaded();
    fireEvent.change(input("Base URL"), {
      target: { value: configuration.baseUrl },
    });
    const modelNames = screen.getByLabelText(
      "Fallback model names",
    ) as HTMLTextAreaElement;
    expect(
      screen.getByText(
        "One per line. Used only when this provider cannot list models.",
      ),
    ).to.exist;

    fireEvent.change(modelNames, {
      target: {
        value: "reviewer/manual-v1\nreviewer/manual-v2\nreviewer/manual-v1",
      },
    });
    expect(button("Save").disabled).to.equal(true);
    fireEvent.change(modelNames, {
      target: { value: "reviewer/manual-v1\nreviewer/manual-v2" },
    });
    fireEvent.click(button("Save"));

    await waitFor(() => expect(saveConfiguration).to.have.been.calledOnce);
    expect(saveConfiguration.firstCall.args.slice(0, 2)).to.deep.equal([
      projectId,
      {
        ...configurationWrite,
        models: ["reviewer/manual-v1", "reviewer/manual-v2"],
      },
    ]);
  });

  it("explains the API base URL and rejects a chat completions endpoint", async function () {
    renderDetails();
    await waitUntilLoaded();

    const baseUrlInput = input("Base URL");
    expect(baseUrlInput.placeholder).to.equal("http://127.0.0.1:11434/v1");
    expect(baseUrlInput.getAttribute("aria-describedby")).to.equal(
      "ai-reviewer-baseUrl-help",
    );
    const help = screen.getByText(
      /Enter the API base through its version prefix/,
    );
    for (const example of [
      "http://127.0.0.1:11434/v1",
      "http://127.0.0.1:8000/v1",
      "http://127.0.0.1:1234/v1",
      "https://api.example.com/v1",
    ]) {
      expect(help.textContent).to.include(example);
    }
    fireEvent.change(baseUrlInput, {
      target: {
        value: "http://127.0.0.1:11434/v1/chat/completions",
      },
    });
    expect(baseUrlInput.getAttribute("aria-invalid")).to.equal("true");
    expect(baseUrlInput.getAttribute("aria-describedby")).to.equal(
      "ai-reviewer-baseUrl-help ai-reviewer-baseUrl-plaintext-warning ai-reviewer-baseUrl-error",
    );
    expect(
      screen.getByText(
        "Remove /chat/completions. The SDK adds that path for requests and adds /models for model discovery.",
      ),
    ).to.exist;
    expect(button("Save").disabled).to.equal(true);
  });

  it("associates state-neutral context guidance with the context override", async function () {
    renderDetails();
    await waitUntilLoaded();

    const baseUrlInput = input("Base URL");
    const contextLengthInput = input("Context length override (tokens)");
    const help = screen.getByText(
      "AI Reviewer needs each model's context length. If this provider does not report it, set Context length override (tokens). For Ollama, OLLAMA_CONTEXT_LENGTH on the server controls the runtime allocation; loading a model manually does not change it.",
    );

    expect(baseUrlInput.getAttribute("aria-describedby")).to.equal(
      "ai-reviewer-baseUrl-help",
    );
    expect(baseUrlInput.getAttribute("aria-describedby")).not.to.include(
      "ai-reviewer-ollama-context-length-help",
    );
    expect(contextLengthInput.getAttribute("aria-describedby")).to.equal(
      "ai-reviewer-contextLengthOverride-help ai-reviewer-ollama-context-length-help",
    );
    expect(help.id).to.equal("ai-reviewer-ollama-context-length-help");
    expect(help.textContent).not.to.include("could not be detected");
    expect(help.textContent).not.to.include("try again");
  });

  it("shows HTTP as unencrypted and blocks an API key until the scheme is HTTPS", async function () {
    renderDetails();
    await waitUntilLoaded();

    const baseUrlInput = input("Base URL");
    const credentialInput = input("API key");
    fireEvent.change(baseUrlInput, {
      target: { value: configuration.baseUrl },
    });
    expect(screen.getByText("HTTP: traffic is not encrypted.")).to.exist;
    expect(baseUrlInput.getAttribute("aria-describedby")).to.equal(
      "ai-reviewer-baseUrl-help ai-reviewer-baseUrl-plaintext-warning",
    );
    expect(button("Save").disabled).to.equal(false);

    fireEvent.change(credentialInput, { target: { value: credential } });
    expect(
      screen.getByText("API key blocked. Use HTTPS or recreate without a key."),
    ).to.exist;
    expect(credentialInput.getAttribute("aria-describedby")).to.equal(
      "ai-reviewer-plaintext-credential-warning",
    );
    expect(button("Save").disabled).to.equal(true);

    fireEvent.change(baseUrlInput, {
      target: { value: "https://localhost:8443/v1" },
    });
    expect(screen.queryByText("HTTP: traffic is not encrypted.")).not.to.exist;
    expect(
      screen.queryByText(
        "API key blocked. Use HTTPS or recreate without a key.",
      ),
    ).not.to.exist;
    expect(button("Save").disabled).to.equal(false);
  });

  it("previews the OpenAI-compatible request URL and omits native destinations", async function () {
    renderDetails();
    await waitUntilLoaded();

    expect(screen.getByText("Requests will go to")).to.exist;
    expect(requestUrlValues()).to.deep.equal([
      "Enter a valid endpoint and any route fields shown above to see the request URL.",
    ]);

    fireEvent.change(input("Base URL"), {
      target: { value: configuration.baseUrl },
    });
    expect(requestUrlValues()).to.deep.equal([
      `${configuration.baseUrl}/chat/completions`,
    ]);

    fireEvent.change(input("Base URL"), {
      target: { value: `${configuration.baseUrl}/chat/completions` },
    });
    expect(requestUrlValues()).to.deep.equal([
      "Enter a valid endpoint and any route fields shown above to see the request URL.",
    ]);
    expect(document.body.textContent).not.to.include(
      "/chat/completions/chat/completions",
    );

    fireEvent.change(providerSelect(), { target: { value: "gemini" } });
    expect(screen.queryByText("Requests will go to")).to.equal(null);
    expect(requestUrlValues()).to.deep.equal([]);
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

    editConnection(otherConfigured);
    // A derived label is shown so the field always matches the listing.
    expect(input("Display name").value).to.equal(otherConfigured.label);
    fireEvent.change(input("Display name"), { target: { value: named.label } });
    fireEvent.click(button("Save"));

    await waitFor(() => expect(saveConfiguration).to.have.been.calledOnce);
    expect(saveConfiguration.firstCall.args[1]).to.deep.equal({
      ...otherConfigurationWrite,
      label: named.label,
    });

    await waitFor(() => expect(button(`Edit ${named.label}`)).to.exist);
    editConnection(named);
    expect(input("Display name").value).to.equal("Lab GPU box");
    fireEvent.change(input("Display name"), { target: { value: "  " } });
    fireEvent.click(button("Save"));

    await waitFor(() => expect(saveConfiguration).to.have.been.calledTwice);
    expect(saveConfiguration.secondCall.args[1]).to.deep.equal({
      ...otherConfigurationWrite,
      label: "",
    });
  });

  it("defaults a new Azure connection to the v1 route and hides API version", async function () {
    const saveConfiguration = sinon.stub().resolves(v1AzureConfigured);
    renderDetails({ saveConfiguration });
    await waitUntilLoaded();

    fireEvent.change(providerSelect(), { target: { value: "azure" } });

    expect(requestStyleSelect().value).to.equal("v1");
    expect(
      screen.getByRole("option", {
        name: "v1 route — shown in the Azure portal today",
      }),
    ).to.exist;
    expect(
      screen.getByRole("option", {
        name: "Deployment route — for older Azure-compatible platforms",
      }),
    ).to.exist;
    expect(screen.queryByLabelText("API version (Optional)")).to.equal(null);

    fireEvent.change(input("Azure OpenAI resource name or endpoint"), {
      target: { value: azurePortalEndpoint },
    });
    expect(input("Deployments and context lengths").value).to.equal(
      azureDeployment,
    );
    expect(screen.getByText("One per line: deployment = tokens.")).to.exist;
    fireEvent.change(input("Deployments and context lengths"), {
      target: { value: `${azureDeployment} = 400000` },
    });
    expect(requestUrlValues()).to.deep.equal([
      `${azureBaseUrl}/v1/chat/completions?api-version=v1`,
    ]);
    fireEvent.change(input("API key"), { target: { value: credential } });
    fireEvent.click(button("Save"));

    await waitFor(() => expect(saveConfiguration).to.have.been.calledOnce);
    expect(saveConfiguration.firstCall.args[1]).to.deep.equal({
      provider: "azure",
      baseUrl: azurePortalEndpoint,
      requestStyle: "v1",
      deployments: [azureDeployment],
      contextLengthOverrides: [
        { model: azureDeployment, contextLength: 400_000 },
      ],
      label: "",
      contextLengthOverride: null,
      credential,
    });
  });

  it("updates Azure request URLs across both request styles", async function () {
    renderDetails();
    await waitUntilLoaded();

    fireEvent.change(providerSelect(), { target: { value: "azure" } });
    fireEvent.change(input("Azure OpenAI resource name or endpoint"), {
      target: { value: `${azureBaseUrl}/v1` },
    });
    fireEvent.change(input("Deployments and context lengths"), {
      target: { value: azureDeployment },
    });
    expect(requestUrlValues()).to.deep.equal([
      `${azureBaseUrl}/v1/chat/completions?api-version=v1`,
    ]);

    fireEvent.change(requestStyleSelect(), {
      target: { value: "deployment" },
    });
    expect(requestUrlValues()).to.deep.equal([
      `${azureBaseUrl}/deployments/${azureDeployment}/chat/completions?api-version=v1`,
    ]);

    fireEvent.change(input("API version (Optional)"), {
      target: { value: azureApiVersion },
    });
    fireEvent.change(input("Deployments and context lengths"), {
      target: { value: `${azureDeployment}\ngpt-4.1-reviewer` },
    });
    expect(requestUrlValues()).to.deep.equal([
      `${azureBaseUrl}/deployments/${azureDeployment}/chat/completions?api-version=${azureApiVersion}`,
      `${azureBaseUrl}/deployments/gpt-4.1-reviewer/chat/completions?api-version=${azureApiVersion}`,
    ]);

    fireEvent.change(input("Deployments and context lengths"), {
      target: { value: "invalid deployment name" },
    });
    expect(requestUrlValues()).to.deep.equal([
      "Enter a valid endpoint and any route fields shown above to see the request URL.",
    ]);

    fireEvent.change(input("Deployments and context lengths"), {
      target: { value: azureDeployment },
    });
    fireEvent.change(requestStyleSelect(), { target: { value: "v1" } });
    fireEvent.change(input("Azure OpenAI resource name or endpoint"), {
      target: { value: "https://azure-compatible.example/openai/v1" },
    });
    expect(requestUrlValues()).to.deep.equal([
      "https://azure-compatible.example/openai/v1/chat/completions",
    ]);
  });

  it("accepts the full Azure deployment endpoint and fills its route fields", async function () {
    const saveConfiguration = sinon.stub().resolves(azureConfigured);
    renderDetails({ saveConfiguration });
    await waitUntilLoaded();

    fireEvent.change(providerSelect(), { target: { value: "azure" } });
    fireEvent.change(requestStyleSelect(), {
      target: { value: "deployment" },
    });
    expect(input("API version (Optional)").value).to.equal("");
    expect(input("API key").required).to.equal(true);
    expect(button("Save").disabled).to.equal(true);

    fireEvent.change(input("Azure OpenAI resource name or endpoint"), {
      target: { value: azurePortalEndpoint },
    });
    expect(input("Deployments and context lengths").value).to.equal(
      azureDeployment,
    );
    expect(input("API version (Optional)").value).to.equal(azureApiVersion);
    fireEvent.change(input("API key"), { target: { value: credential } });
    expect(button("Save").disabled).to.equal(false);
    fireEvent.click(button("Save"));

    await waitFor(() => expect(saveConfiguration).to.have.been.calledOnce);
    expect(saveConfiguration.firstCall.args.slice(0, 2)).to.deep.equal([
      projectId,
      { ...azureConfigurationWrite, credential },
    ]);
  });

  it("warns and suppresses saving when an Azure API key would use HTTP", async function () {
    renderDetails();
    await waitUntilLoaded();

    fireEvent.change(providerSelect(), { target: { value: "azure" } });
    fireEvent.change(input("Azure OpenAI resource name or endpoint"), {
      target: { value: plaintextAzureBaseUrl },
    });
    fireEvent.change(input("Deployments and context lengths"), {
      target: { value: azureDeployment },
    });
    fireEvent.change(input("API key"), { target: { value: credential } });

    expect(
      screen.getByText("API key blocked. Use HTTPS or recreate without a key."),
    ).to.exist;
    expect(button("Save").disabled).to.equal(true);

    fireEvent.change(input("Azure OpenAI resource name or endpoint"), {
      target: { value: azureBaseUrl },
    });
    expect(
      screen.queryByText(
        "API key blocked. Use HTTPS or recreate without a key.",
      ),
    ).not.to.exist;
    expect(button("Save").disabled).to.equal(false);
  });

  it("keeps the optional deployment API version blank and explains endpoint normalization", async function () {
    const saveConfiguration = sinon.stub().resolves(blankAzureConfigured);
    renderDetails({ saveConfiguration });
    await waitUntilLoaded();

    fireEvent.change(providerSelect(), { target: { value: "azure" } });
    fireEvent.change(requestStyleSelect(), {
      target: { value: "deployment" },
    });

    const apiVersionInput = input("API version (Optional)");
    const endpointInput = input("Azure OpenAI resource name or endpoint");
    expect(apiVersionInput.value).to.equal("");
    expect(apiVersionInput.required).to.equal(false);
    expect(apiVersionInput.getAttribute("aria-required")).to.equal(null);
    expect(apiVersionInput.getAttribute("aria-describedby")).to.equal(
      "ai-reviewer-apiVersion-help",
    );
    expect(
      screen.getByText(
        "The deployment route sends this as ?api-version=. Leave blank to use the SDK default, v1.",
      ),
    ).to.exist;
    expect(endpointInput.getAttribute("aria-describedby")).to.equal(
      "ai-reviewer-azure-endpoint-help",
    );
    expect(
      screen.getByText(
        "An endpoint ending in /openai/v1 is stored as /openai. The SDK adds the path for the request style selected above.",
      ),
    ).to.exist;
    expect(providerSelect().getAttribute("aria-describedby")).to.equal(
      "ai-reviewer-azure-provider-help",
    );
    expect(
      screen.getByText(
        "Connects to Azure OpenAI Service. Enter its resource name or endpoint, then choose the request style that endpoint supports.",
      ),
    ).to.exist;

    fireEvent.change(input("Azure OpenAI resource name or endpoint"), {
      target: { value: azureBaseUrl },
    });
    fireEvent.change(input("Deployments and context lengths"), {
      target: { value: azureDeployment },
    });
    fireEvent.change(apiVersionInput, { target: { value: "" } });
    fireEvent.change(input("API key"), { target: { value: credential } });
    expect(button("Save").disabled).to.equal(false);
    fireEvent.click(button("Save"));

    await waitFor(() => expect(saveConfiguration).to.have.been.calledOnce);
    expect(saveConfiguration.firstCall.args[1]).to.deep.equal({
      provider: "azure",
      baseUrl: azureBaseUrl,
      requestStyle: "deployment",
      deployments: [azureDeployment],
      contextLengthOverrides: [],
      label: "",
      contextLengthOverride: null,
      credential,
    });
    await waitFor(
      () => expect(button(`Edit ${blankAzureConfigured.label}`)).to.exist,
    );
    editConnection(blankAzureConfigured);
    expect(requestStyleSelect().value).to.equal("deployment");
    expect(input("API version (Optional)").value).to.equal("");
  });

  it("lets a saved Azure connection switch explicitly from deployment to v1", async function () {
    const updateConnection = sinon.stub().resolves(v1AzureConfigured);
    renderConnections({
      listConnections: sinon
        .stub()
        .resolves({ connections: [azureConfigured] }),
      updateConnection,
    });
    await waitUntilLoaded();

    editConnection(azureConfigured);
    expect(requestStyleSelect().value).to.equal("deployment");
    expect(input("API version (Optional)").value).to.equal(azureApiVersion);

    fireEvent.change(requestStyleSelect(), { target: { value: "v1" } });
    expect(screen.queryByLabelText("API version (Optional)")).to.equal(null);
    fireEvent.click(button("Save"));

    await waitFor(() => expect(updateConnection).to.have.been.calledOnce);
    expect(updateConnection.firstCall.args.slice(0, 4)).to.deep.equal([
      projectId,
      connectionId,
      azureConfigured.revision,
      {
        provider: "azure",
        baseUrl: azureBaseUrl,
        requestStyle: "v1",
        deployments: [azureDeployment],
        contextLengthOverrides: [],
        label: azureConfigured.label,
        contextLengthOverride: null,
      },
    ]);
  });

  it("communicates API key requiredness through field state without changing the label", async function () {
    renderDetails();
    await waitUntilLoaded();

    const apiKeyInput = input("API key");
    expect(apiKeyInput.required).to.equal(false);
    expect(apiKeyInput.getAttribute("aria-required")).to.equal("false");

    for (const provider of ["gemini", "claude", "azure"]) {
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

      editConnection(native.response);
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

      expect(testConnectionButton(native.response).disabled).to.equal(false);
      fireEvent.click(testConnectionButton(native.response));

      await waitFor(() => expect(testConnection).to.have.been.calledOnce);
      expect(testConnection.firstCall.args).to.have.length(3);
      expect(testConnection.firstCall.args[0]).to.equal(projectId);
      await screen.findByText("Connection successful");
    });
  }

  it("keeps a selected saved connection untouched when a provider switch is attempted", async function () {
    const updateConnection = sinon.stub().resolves(geminiConfigured);
    const createConnection = sinon.stub().resolves(geminiConfigured);
    renderConnections({
      listConnections: sinon
        .stub()
        .resolves({ connections: [azureConfigured] }),
      updateConnection,
      createConnection,
    });
    await waitUntilLoaded();

    editConnection(azureConfigured);
    expect(providerSelect().value).to.equal("azure");
    expect(providerSelect().disabled).to.equal(true);
    expect(input("Azure OpenAI resource name or endpoint").value).to.equal(
      azureBaseUrl,
    );
    expect(screen.getByText("API key set")).to.exist;
    fireEvent.change(providerSelect(), { target: { value: "gemini" } });
    fireEvent.submit(
      document.querySelector(".ai-reviewer-provider-settings-form")!,
    );

    expect(providerSelect().value).to.equal("azure");
    expect(input("Azure OpenAI resource name or endpoint").value).to.equal(
      azureBaseUrl,
    );
    expect(input("API key").value).to.equal("");
    expect(updateConnection).not.to.have.been.called;
    expect(createConnection).not.to.have.been.called;
    expect(connectionRows()).to.have.length(1);
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
    editConnection(otherConfigured);
    const credentialInput = input("API key");
    expect(credentialInput.type).to.equal("password");
    expect(credentialInput.value).to.equal("");
    expect(credentialInput.autocomplete).to.equal("new-password");
    expect(credentialInput.required).to.equal(false);
    expect(credentialInput.getAttribute("aria-required")).to.equal("false");
    expect(screen.getByText("OpenAI-compatible")).to.exist;
    expect(screen.getByText("API key set")).to.exist;
    expect(credentialUpdateTime(credentialUpdatedAt).dateTime).to.equal(
      credentialUpdatedAt,
    );
    expect(document.body.textContent).not.to.include(credential);
  });

  it("uses the URL scheme, not local classification, for plaintext and saved-key warnings", async function () {
    const plaintextCredentialConfigured: AiProviderConnection = {
      ...configured,
      config: {
        ...configuration,
        credentialSet: true,
        credentialUpdatedAt,
      },
    };
    const encryptedLocalConfigured: AiProviderConnection = {
      ...configured,
      id: secondConnectionId,
      label: "localhost:8443",
      classification: "local",
      config: {
        ...configuration,
        baseUrl: "https://localhost:8443/v1",
        credentialSet: true,
        credentialUpdatedAt,
      },
    };
    const plaintextAzureConfigured: AiProviderConnection = {
      ...azureConfigured,
      id: "connection-plaintext-azure",
      label: "host.docker.internal:11434",
      classification: "local",
      config: {
        ...azureConfiguration,
        baseUrl: plaintextAzureBaseUrl,
      },
    };
    renderConnections({
      listConnections: sinon.stub().resolves({
        connections: [
          plaintextCredentialConfigured,
          encryptedLocalConfigured,
          plaintextAzureConfigured,
        ],
      }),
    });
    await waitUntilLoaded({ openEmptyForm: false });

    const [plaintextRow, encryptedRow, plaintextAzureRow] = connectionRows();
    expect(within(plaintextRow).getByText("HTTP: traffic is not encrypted.")).to
      .exist;
    expect(
      within(plaintextRow).getByText(
        "API key blocked. Use HTTPS or recreate without a key.",
      ),
    ).to.exist;
    expect(within(encryptedRow).queryByText("HTTP: traffic is not encrypted."))
      .not.to.exist;
    expect(
      within(encryptedRow).queryByText(
        "API key blocked. Use HTTPS or recreate without a key.",
      ),
    ).not.to.exist;
    expect(
      within(plaintextAzureRow).getByText("HTTP: traffic is not encrypted."),
    ).to.exist;
    expect(
      within(plaintextAzureRow).getByText(
        "API key blocked. Use HTTPS or recreate without a key.",
      ),
    ).to.exist;
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
    editConnection(geminiConfigured);
    expect(providerSelect().value).to.equal("gemini");
    expect(screen.queryByLabelText("Base URL")).not.to.exist;
    const apiKeyInput = input("API key");
    expect(apiKeyInput.value).to.equal("");
    expect(apiKeyInput.required).to.equal(false);
    expect(apiKeyInput.getAttribute("aria-required")).to.equal("false");
    expect(
      connectionRows()[0].querySelector(".ai-reviewer-connection-provider")
        ?.textContent,
    ).to.equal("Google Gemini");
    expect(screen.getByText("API key set")).to.exist;
    expect(credentialUpdateTime(credentialUpdatedAt).dateTime).to.equal(
      credentialUpdatedAt,
    );
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

    editConnection(otherConfigured);
    fireEvent.change(input("API key"), {
      target: { value: credential },
    });
    expect(button("Save").disabled).to.equal(false);
    expect(testConnectionButton(otherConfigured).disabled).to.equal(true);
    fireEvent.click(button("Save"));

    await waitFor(() => expect(saveConfiguration).to.have.been.calledOnce);
    expect(saveConfiguration.firstCall.args.slice(0, 2)).to.deep.equal([
      projectId,
      {
        ...otherConfigurationWrite,
        credential,
      },
    ]);
    await waitFor(() =>
      expect(testConnectionButton(replacementResponse).disabled).to.equal(
        false,
      ),
    );
    expect(
      credentialUpdateTime(replacementCredentialUpdatedAt).dateTime,
    ).to.equal(replacementCredentialUpdatedAt);
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

  it("loads and clears reasoning model compatibility from advanced settings", async function () {
    const compatible: AiProviderConnection = {
      ...otherConfigured,
      config: {
        ...otherConfiguration,
        reasoningModelCompatibility: true,
      },
    };
    const saveConfiguration = sinon.stub().resolves(compatible);
    renderDetails({
      getConfiguration: sinon.stub().resolves(compatible),
      saveConfiguration,
    });
    await waitUntilLoaded();

    editConnection(compatible);
    fireEvent.click(screen.getByText("Advanced settings"));
    const compatibility = screen.getByRole("checkbox", {
      name: "Reasoning model compatibility",
    });
    const compatibilityHelp = screen.getByText(
      "Do not send temperature, top-p, or seed. Enable this for reasoning models such as GPT-5 and the o-series, which may reject sampling parameters.",
    );
    expect(compatibility.getAttribute("aria-describedby")).to.equal(
      compatibilityHelp.id,
    );
    expect((compatibility as HTMLInputElement).checked).to.equal(true);
    fireEvent.click(compatibility);
    fireEvent.click(button("Save"));

    await waitFor(() => expect(saveConfiguration).to.have.been.calledOnce);
    expect(saveConfiguration.firstCall.args[1]).to.deep.equal({
      ...otherConfigurationWrite,
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

    editConnection(overridden);
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
    expect(testConnectionButton(configured).disabled).to.equal(false);

    editConnection(configured);
    fireEvent.change(input("Base URL"), {
      target: { value: otherConfiguration.baseUrl },
    });
    expect(testConnectionButton(configured).disabled).to.equal(true);
    fireEvent.click(button("Save"));
    expect(testConnectionButton(configured).disabled).to.equal(true);

    pendingSave.resolve(otherConfigured);
    await waitFor(() =>
      expect(testConnectionButton(otherConfigured).disabled).to.equal(false),
    );
    expect(screen.getByText("OpenAI-compatible")).to.exist;
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
        scopeKey={otherProjectId}
        {...rendered.props}
      />,
    );

    await waitFor(() => expect(oldSignal.aborted).to.equal(true));
    await waitFor(() => expect(connectionRows()).to.have.length(1));
    editConnection(otherConfigured);
    expect(input("Base URL").value).to.equal(otherConfiguration.baseUrl);
    await act(async () => firstLoad.resolve(configured));
    expect(input("Base URL").value).to.equal(otherConfiguration.baseUrl);
    expect(screen.getByText("OpenAI-compatible")).to.exist;
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

  it("shows connection metadata without a form and edits only from the row action", async function () {
    const listConnections = sinon
      .stub()
      .resolves({ connections: [otherConfigured, claudeConfigured] });
    renderConnections({ listConnections });
    await waitUntilLoaded();

    expect(connectionRows()).to.have.length(2);
    expect(within(connectionRows()[0]).getByText(otherConfigured.label)).to
      .exist;
    expect(within(connectionRows()[0]).getByText("OpenAI-compatible")).to.exist;
    expect(within(connectionRows()[0]).getByText("API key set")).to.exist;
    expect(
      within(connectionRows()[0]).getByTitle(credentialUpdatedAt).textContent,
    ).not.to.equal(`Last updated: ${credentialUpdatedAt}`);
    expect(
      connectionRows()[1].querySelector(".ai-reviewer-connection-name-cell")
        ?.textContent,
    ).to.include("Anthropic Claude");
    expect(
      document.querySelector(".ai-reviewer-provider-settings-form"),
    ).to.equal(null);

    editConnection(claudeConfigured);
    expect(providerSelect().disabled).to.equal(true);
    expect(input("Display name").disabled).to.equal(false);
    expect(input("Display name").value).to.equal(claudeConfigured.label);
    expect(
      screen.getByRole("heading", {
        name: `Edit connection: ${claudeConfigured.label}`,
      }),
    ).to.exist;
    expect(document.body.textContent).not.to.include(credential);
  });

  it("uses named icon actions and a danger treatment in the Connections tab", async function () {
    const listConnections = sinon
      .stub()
      .resolves({ connections: [otherConfigured] });
    renderConnections({ listConnections });
    await waitUntilLoaded();

    const row = connectionRows()[0];
    expect(within(row).getByText(otherConfigured.label)).to.exist;
    expect(testConnectionButton(otherConfigured)).to.exist;
    expect(
      screen.queryByText(
        "Connection tests are only available within a project.",
      ),
    ).not.to.exist;
    const edit = button(`Edit ${otherConfigured.label}`);
    const remove = deleteConnectionButton(otherConfigured);
    expect(edit.classList.contains("btn-secondary")).to.equal(true);
    expect(remove.classList.contains("btn-danger")).to.equal(true);
    expect(
      screen
        .getByRole("tab", { name: "Connections" })
        .getAttribute("aria-selected"),
    ).to.equal("true");
    expect(screen.queryByRole("heading", { name: "Skills" })).to.equal(null);
  });

  it("hides the form until Add is chosen and confirms a dirty Cancel", async function () {
    renderConnections();
    await waitUntilLoaded({ openEmptyForm: false });

    expect(screen.getByText("0 of 10 connections")).to.exist;
    expect(screen.queryByLabelText("Provider")).not.to.exist;
    fireEvent.click(button("Add connection"));
    expect(screen.getByRole("heading", { name: "Add connection" })).to.exist;
    fireEvent.change(input("Display name"), {
      target: { value: "Unsaved connection" },
    });
    fireEvent.click(button("Cancel"));

    expect(screen.getByText("Discard unsaved changes?")).to.exist;
    expect(screen.getByLabelText("Provider")).to.exist;
    fireEvent.click(button("Discard changes"));
    await waitFor(
      () => expect(screen.queryByLabelText("Provider")).not.to.exist,
    );
  });

  it("adds a second connection without disturbing the first", async function () {
    const onHide = sinon.stub();
    const listConnections = sinon
      .stub()
      .resolves({ connections: [otherConfigured] });
    const createConnection = sinon.stub().resolves(claudeConfigured);
    const updateConnection = sinon.stub().resolves(otherConfigured);
    renderConnections({
      onHide,
      listConnections,
      createConnection,
      updateConnection,
    });
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
    fireEvent.click(closeSettingsButton());
    expect(onHide).to.have.been.calledOnceWithExactly(true);
  });

  it("reports a possible connection change when closing during a save", async function () {
    const onHide = sinon.stub();
    const pendingSave = deferred<AiProviderConnection>();
    const createConnection = sinon.stub().returns(pendingSave.promise);
    renderConnections({ onHide, createConnection });
    await waitUntilLoaded();

    fireEvent.change(providerSelect(), { target: { value: "claude" } });
    fireEvent.change(input("API key"), { target: { value: credential } });
    fireEvent.click(button("Save"));
    await waitFor(() => expect(createConnection).to.have.been.calledOnce);

    const signal = createConnection.firstCall.args[2] as AbortSignal;
    fireEvent.click(closeSettingsButton());
    expect(screen.getByText("Discard unsaved changes?")).to.exist;
    fireEvent.click(button("Discard changes"));

    expect(signal.aborted).to.equal(true);
    expect(onHide).to.have.been.calledOnceWithExactly(true);
  });

  it("reports a possible connection change after a save request fails", async function () {
    const onHide = sinon.stub();
    const createConnection = sinon.stub().rejects(new Error("parse failed"));
    renderConnections({ onHide, createConnection });
    await waitUntilLoaded();

    fireEvent.change(providerSelect(), { target: { value: "claude" } });
    fireEvent.change(input("API key"), { target: { value: credential } });
    fireEvent.click(button("Save"));

    expect(
      await screen.findByText(
        "Something went wrong. Check the settings and try again.",
      ),
    ).to.exist;
    expect(createConnection).to.have.been.calledOnce;
    fireEvent.click(closeSettingsButton());
    fireEvent.click(button("Discard changes"));

    expect(onHide).to.have.been.calledOnceWithExactly(true);
  });

  it("confirms before discarding edits when switching rows or closing", async function () {
    const onHide = sinon.stub();
    const listConnections = sinon
      .stub()
      .resolves({ connections: [otherConfigured, claudeConfigured] });
    renderConnections({ onHide, listConnections });
    await waitUntilLoaded();

    editConnection(otherConfigured);
    fireEvent.change(input("Display name"), {
      target: { value: "Unsaved first connection" },
    });
    editConnection(claudeConfigured);

    expect(screen.getByText("Discard unsaved changes?")).to.exist;
    expect(providerSelect().value).to.equal("openai-compatible");
    fireEvent.click(button("Discard changes"));
    await waitFor(
      () => expect(screen.queryByText("Discard unsaved changes?")).not.to.exist,
    );
    expect(providerSelect().value).to.equal("claude");
    expect(input("Display name").disabled).to.equal(false);

    fireEvent.change(input("Display name"), {
      target: { value: "Unsaved second connection" },
    });
    fireEvent.click(closeSettingsButton());
    expect(onHide).not.to.have.been.called;
    expect(screen.getByText("Discard unsaved changes?")).to.exist;
    fireEvent.click(button("Discard changes"));
    await waitFor(
      () => expect(screen.queryByText("Discard unsaved changes?")).not.to.exist,
    );
    expect(onHide).to.have.been.calledOnceWithExactly(false);
  });

  it("updates a connection only after its explicit edit action", async function () {
    const onHide = sinon.stub();
    const listConnections = sinon
      .stub()
      .resolves({ connections: [claudeConfigured, otherConfigured] });
    const updateConnection = sinon.stub().resolves(claudeConfigured);
    renderConnections({ onHide, listConnections, updateConnection });
    await waitUntilLoaded();

    expect(screen.queryByLabelText("Display name")).not.to.exist;
    editConnection(claudeConfigured);
    fireEvent.change(input("Display name"), {
      target: { value: "Renamed connection" },
    });
    fireEvent.click(button("Save"));

    await waitFor(() => expect(updateConnection).to.have.been.calledOnce);
    expect(updateConnection.firstCall.args.slice(0, 4)).to.deep.equal([
      projectId,
      secondConnectionId,
      claudeConfigured.revision,
      {
        ...claudeConfigurationWrite,
        label: "Renamed connection",
      },
    ]);
    await waitFor(() =>
      expect(screen.queryByLabelText("Display name")).not.to.exist,
    );
    fireEvent.click(closeSettingsButton());
    expect(onHide).to.have.been.calledOnceWithExactly(true);
  });

  it("confirms deletion with the number of projects using the connection", async function () {
    const onHide = sinon.stub();
    const usedClaudeConnection = {
      ...claudeConfigured,
      projectUseCount: 3,
    };
    const listConnections = sinon
      .stub()
      .resolves({ connections: [usedClaudeConnection, otherConfigured] });
    const deleteConnection = sinon
      .stub()
      .resolves({ connections: [otherConfigured] });
    renderConnections({ onHide, listConnections, deleteConnection });
    await waitUntilLoaded();

    fireEvent.click(deleteConnectionButton(usedClaudeConnection));

    expect(deleteConnection).not.to.have.been.called;
    expect(
      screen.getByText(
        "This permanently deletes this connection and its saved API key. Projects currently selecting it: 3. Those projects will require a new connection selection before review.",
      ),
    ).to.exist;
    fireEvent.click(button("Delete"));

    await waitFor(() => expect(deleteConnection).to.have.been.calledOnce);
    expect(deleteConnection.firstCall.args.slice(0, 3)).to.deep.equal([
      projectId,
      secondConnectionId,
      usedClaudeConnection.revision,
    ]);
    await waitFor(() => expect(connectionRows()).to.have.length(1));
    expect(within(connectionRows()[0]).getByText(otherConfigured.label)).to
      .exist;
    expect(screen.queryByLabelText("Provider")).not.to.exist;
    fireEvent.click(closeSettingsButton());
    expect(onHide).to.have.been.calledOnceWithExactly(true);
  });

  it("reports a possible connection change after a delete request fails", async function () {
    const onHide = sinon.stub();
    const listConnections = sinon
      .stub()
      .resolves({ connections: [otherConfigured] });
    const deleteConnection = sinon.stub().rejects(new Error("parse failed"));
    renderConnections({ onHide, listConnections, deleteConnection });
    await waitUntilLoaded();

    fireEvent.click(deleteConnectionButton(otherConfigured));
    fireEvent.click(button("Delete"));

    expect(
      await screen.findByText(
        "Something went wrong. Check the settings and try again.",
      ),
    ).to.exist;
    expect(deleteConnection).to.have.been.calledOnce;
    fireEvent.click(closeSettingsButton());

    expect(onHide).to.have.been.calledOnceWithExactly(true);
  });

  it("disables the add control when ten connections already exist", async function () {
    const tenConnections = Array.from({ length: 10 }, (_, index) => ({
      ...otherConfigured,
      id: `connection-${index}`,
      label: `Connection ${index}`,
    }));
    const listConnections = sinon
      .stub()
      .resolves({ connections: tenConnections });
    const createConnection = sinon.stub();
    renderConnections({ listConnections, createConnection });
    await waitUntilLoaded();

    expect(button("Add connection").disabled).to.equal(true);
    expect(button("Add connection").getAttribute("aria-describedby")).to.equal(
      "ai-reviewer-connection-limit-help",
    );
    expect(
      screen.getByText("No more connections can be added. Delete one first."),
    ).to.exist;
    fireEvent.click(button("Add connection"));
    expect(createConnection).not.to.have.been.called;
    expect(connectionRows()).to.have.length(10);
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
    fireEvent.click(testConnectionButton(configured));

    await screen.findByText(
      "The AI provider could not be reached. Check the provider settings and network connection, then try again.",
    );
    expect(document.body.textContent).not.to.include(rawPayload);
  });

  it("surfaces an invalid configuration response as field guidance", async function () {
    fetchMock.get(`/project/${projectId}/ai-reviewer/connections`, {
      connections: [],
    });
    fetchMock.post(`/project/${projectId}/ai-reviewer/connections`, {
      status: 400,
      headers: { "Content-Type": "application/json" },
      body: {
        error: {
          code: "AI_PROVIDER_CONFIGURATION_INVALID",
          category: "configuration",
          message: rawPayload,
          retryable: false,
        },
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
      "The connection settings are invalid. Check the request style, endpoint format, deployment names, API version when shown, and required API key.",
    );
    expect(document.body.textContent).not.to.include(rawPayload);
    expect(document.body.textContent).not.to.include(
      "Something went wrong. Check the settings and try again.",
    );
  });

  it("tells the user when an edit was refused because the connection changed elsewhere", async function () {
    fetchMock.get(`/project/${projectId}/ai-reviewer/connections`, {
      connections: [configured],
    });
    fetchMock.put(
      `/project/${projectId}/ai-reviewer/connections/${connectionId}`,
      {
        status: 409,
        headers: { "Content-Type": "application/json" },
        body: {
          error: {
            code: "AI_PROVIDER_CONNECTION_CONFLICT",
            category: "configuration",
            message: rawPayload,
            retryable: false,
          },
        },
      },
    );
    render(
      <ProjectProvider>
        <AiIntegrationDetails onHide={sinon.stub()} />
      </ProjectProvider>,
    );
    await waitUntilLoaded();
    editConnection(configured);
    fireEvent.change(input("Display name"), {
      target: { value: "Conflict candidate" },
    });
    fireEvent.click(button("Save"));

    await screen.findByText(
      "This connection changed elsewhere. Your change was not applied. Reload the settings and try again.",
    );
    expect(document.body.textContent).not.to.include(rawPayload);
    expect(document.body.textContent).not.to.include(credential);
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
    fireEvent.click(testConnectionButton(otherConfigured));

    await screen.findByText("The AI provider rejected its credentials.");
    expect(document.body.textContent).not.to.include(rawPayload);
    expect(document.body.textContent).not.to.include(credential);
  });
});
