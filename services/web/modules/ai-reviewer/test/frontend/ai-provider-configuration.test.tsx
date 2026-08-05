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
const configuration: AiProviderConfiguration = {
  provider: "ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "qwen3.5:4b",
};
const otherConfiguration: AiProviderConfiguration = {
  provider: "ollama",
  baseUrl: "http://localhost:11434/v1",
  model: "other-model:latest",
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
  classification: "local",
};
const connectionResponse = {
  ok: true as const,
  provider: "ollama" as const,
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

  it("saves exactly the three provider fields through PUT", async function () {
    const route = fetchMock.put(
      `/project/${projectId}/ai-reviewer/config`,
      configured,
    );
    const signal = new AbortController().signal;
    const candidate = {
      ...configuration,
      token: "must-not-be-sent",
    } as AiProviderConfiguration;

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
    ]);
    expect(JSON.parse(String(call.options.body))).to.deep.equal(configuration);
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

  it("loads, edits, saves, and tests an Ollama configuration", async function () {
    const { saveConfiguration, testConnection } = renderDetails();
    await waitUntilLoaded();

    fireEvent.change(input("Base URL"), {
      target: { value: configuration.baseUrl },
    });
    fireEvent.change(input("Model"), {
      target: { value: configuration.model },
    });
    fireEvent.click(button("Save"));

    await waitFor(() => expect(saveConfiguration).to.have.been.calledOnce);
    expect(saveConfiguration.firstCall.args.slice(0, 2)).to.deep.equal([
      projectId,
      configuration,
    ]);
    await screen.findByText("Local");

    fireEvent.click(button("Test connection"));
    await waitFor(() => expect(testConnection).to.have.been.calledOnce);
    expect(testConnection.firstCall.args).to.have.length(2);
    expect(testConnection.firstCall.args[0]).to.equal(projectId);
    await screen.findByText("Connection successful");
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
      "Ollama is unavailable. Start Ollama and try the connection again.",
    );
    expect(document.body.textContent).not.to.include(rawPayload);
  });
});
