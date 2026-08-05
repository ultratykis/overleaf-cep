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
  credentialSet: false,
  credentialUpdatedAt: null,
};
const otherConfiguration: AiProviderConfiguration = {
  provider: "openai-compatible",
  baseUrl: "https://api.example.com/v1",
  model: "hosted-model",
  contextLength: 4_096,
  credentialSet: true,
  credentialUpdatedAt,
};
const configurationWrite: AiProviderConfigurationWrite = {
  provider: configuration.provider,
  baseUrl: configuration.baseUrl,
  model: configuration.model,
  contextLength: configuration.contextLength,
};
const otherConfigurationWrite: AiProviderConfigurationWrite = {
  provider: otherConfiguration.provider,
  baseUrl: otherConfiguration.baseUrl,
  model: otherConfiguration.model,
  contextLength: otherConfiguration.contextLength,
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
  await waitFor(() => expect(input("Base URL").disabled).to.equal(false));
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
      ...configuration,
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
      "contextLength",
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
      "contextLength",
      "credential",
    ]);
    expect(body).to.deep.equal({
      ...otherConfigurationWrite,
      credential,
    });
    expect(JSON.stringify(body)).not.to.include("must-not-be-sent");
  });

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

    fireEvent.change(input("Base URL"), {
      target: { value: configuration.baseUrl },
    });
    fireEvent.change(input("Model"), {
      target: { value: configuration.model },
    });
    fireEvent.change(input("Context length (tokens)"), {
      target: { value: String(configuration.contextLength) },
    });
    fireEvent.click(button("Save"));

    await waitFor(() => expect(saveConfiguration).to.have.been.calledOnce);
    expect(saveConfiguration.firstCall.args.slice(0, 2)).to.deep.equal([
      projectId,
      configurationWrite,
    ]);
    await screen.findByText("Local");
    await screen.findByText("No credential set");

    fireEvent.click(button("Test connection"));
    await waitFor(() => expect(testConnection).to.have.been.calledOnce);
    expect(testConnection.firstCall.args).to.have.length(2);
    expect(testConnection.firstCall.args[0]).to.equal(projectId);
    await screen.findByText("Connection successful");
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
    const credentialInput = input("Credential (optional)");
    expect(credentialInput.type).to.equal("password");
    expect(credentialInput.value).to.equal("");
    expect(credentialInput.autocomplete).to.equal("new-password");
    expect(screen.getByText("Remote")).to.exist;
    expect(screen.getByText("Credential set")).to.exist;
    expect(screen.getByText(`Last updated: ${credentialUpdatedAt}`)).to.exist;
    expect(document.body.textContent).not.to.include(credential);
  });

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

    fireEvent.change(input("Credential (optional)"), {
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
    await waitFor(() =>
      expect(input("Credential (optional)").value).to.equal(""),
    );
    expect(button("Test connection").disabled).to.equal(false);
    expect(screen.getByText(`Last updated: ${replacementCredentialUpdatedAt}`))
      .to.exist;
  });

  it("requires a positive integer context length before saving", async function () {
    renderDetails();
    await waitUntilLoaded();
    fireEvent.change(input("Base URL"), {
      target: { value: configuration.baseUrl },
    });
    fireEvent.change(input("Model"), {
      target: { value: configuration.model },
    });

    for (const value of ["0", "-1", "1.5"]) {
      fireEvent.change(input("Context length (tokens)"), { target: { value } });
      expect(button("Save").disabled).to.equal(true);
    }

    fireEvent.change(input("Context length (tokens)"), {
      target: { value: String(configuration.contextLength) },
    });
    expect(button("Save").disabled).to.equal(false);
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
    expect(input("Context length (tokens)").value).to.equal(
      String(otherConfiguration.contextLength),
    );
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
    expect(input("Context length (tokens)").value).to.equal(
      String(otherConfiguration.contextLength),
    );
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
      "The AI provider could not be reached. Check the base URL and try again.",
    );
    expect(document.body.textContent).not.to.include(rawPayload);
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
