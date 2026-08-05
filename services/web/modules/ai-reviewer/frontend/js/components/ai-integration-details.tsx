import { useProjectContext } from "@/shared/context/project-context";
import OLButton from "@/shared/components/ol/ol-button";
import OLForm from "@/shared/components/ol/ol-form";
import OLFormControl from "@/shared/components/ol/ol-form-control";
import OLFormGroup from "@/shared/components/ol/ol-form-group";
import OLFormLabel from "@/shared/components/ol/ol-form-label";
import OLFormSelect from "@/shared/components/ol/ol-form-select";
import {
  OLModal,
  OLModalBody,
  OLModalFooter,
  OLModalHeader,
  OLModalTitle,
} from "@/shared/components/ol/ol-modal";
import OLNotification from "@/shared/components/ol/ol-notification";
import type { TFunction } from "i18next";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import "../../stylesheets/ai-reviewer.scss";
import {
  AiProviderConfigurationClientError,
  type AiProvider,
  type AiProviderConfiguration,
  type AiProviderConfigurationClientErrorCode,
  type AiProviderContextLengthSource,
  type AiProviderConfigurationResponse,
  type AiProviderConfigurationWrite,
  getAiProviderConfiguration,
  saveAiProviderConfiguration,
  testAiProviderConnection,
} from "../services/ai-provider-configuration";

type OperationKind = "save" | "test";
type Operation = { generation: number; controller: AbortController };
type Notice =
  | { type: "success"; kind: "connectionSuccessful" }
  | {
      type: "error";
      kind: "generic" | AiProviderConfigurationClientErrorCode;
    };
type ConfigurationDraft = {
  provider: AiProviderConfiguration["provider"];
  baseUrl: string;
  model: string;
  contextLengthOverride: string;
  credential: string;
};
type ConfigurationField =
  | "baseUrl"
  | "model"
  | "contextLengthOverride"
  | "credential";

type Props = {
  projectId: string;
  onHide: () => void;
  getConfiguration: typeof getAiProviderConfiguration;
  saveConfiguration: typeof saveAiProviderConfiguration;
  testConnection: typeof testAiProviderConnection;
};

const emptyConfiguration: ConfigurationDraft = {
  provider: "openai-compatible",
  baseUrl: "",
  model: "",
  contextLengthOverride: "",
  credential: "",
};

const fields: ConfigurationField[] = ["baseUrl", "model", "credential"];

const providers: AiProvider[] = ["openai-compatible", "gemini", "claude"];

function providerFromValue(value: string): AiProvider | null {
  switch (value) {
    case "openai-compatible":
    case "gemini":
    case "claude":
      return value;
    default:
      return null;
  }
}

function copyPublicConfiguration(
  configuration: AiProviderConfiguration,
): AiProviderConfiguration {
  const common = {
    model: configuration.model,
    contextLength: configuration.contextLength,
    contextLengthSource: configuration.contextLengthSource,
    credentialSet: configuration.credentialSet,
    credentialUpdatedAt: configuration.credentialUpdatedAt,
  };
  switch (configuration.provider) {
    case "openai-compatible":
      return {
        provider: configuration.provider,
        baseUrl: configuration.baseUrl,
        ...common,
      };
    case "gemini":
      return {
        provider: configuration.provider,
        ...common,
      };
    case "claude":
      return {
        provider: configuration.provider,
        ...common,
      };
  }
}

function draftFromConfiguration(
  configuration: AiProviderConfiguration,
): ConfigurationDraft {
  const common = {
    model: configuration.model,
    contextLengthOverride:
      configuration.contextLengthSource === "override"
        ? String(configuration.contextLength)
        : "",
    credential: "",
  };
  switch (configuration.provider) {
    case "openai-compatible":
      return {
        provider: configuration.provider,
        baseUrl: configuration.baseUrl,
        ...common,
      };
    case "gemini":
      return {
        provider: configuration.provider,
        baseUrl: "",
        ...common,
      };
    case "claude":
      return {
        provider: configuration.provider,
        baseUrl: "",
        ...common,
      };
  }
}

function providerLabel(provider: AiProvider, t: TFunction): string {
  switch (provider) {
    case "openai-compatible":
      return t("ai_reviewer_provider_openai_compatible");
    case "gemini":
      return t("ai_reviewer_provider_gemini");
    case "claude":
      return t("ai_reviewer_provider_claude");
  }
}

function fieldLabel(field: ConfigurationField, t: TFunction): string {
  switch (field) {
    case "baseUrl":
      return t("ai_reviewer_provider_base_url");
    case "model":
      return t("ai_reviewer_provider_model");
    case "contextLengthOverride":
      return t("ai_reviewer_provider_context_length_override");
    case "credential":
      return t("ai_reviewer_provider_credential");
  }
}

function contextLengthSourceLabel(
  source: AiProviderContextLengthSource,
  t: TFunction,
): string {
  switch (source) {
    case "derived":
      return t("ai_reviewer_provider_context_length_source_derived");
    case "detected":
      return t("ai_reviewer_provider_context_length_source_detected");
    case "default":
      return t("ai_reviewer_provider_context_length_source_default");
    case "override":
      return t("ai_reviewer_provider_context_length_source_override");
  }
}

function genericErrorNotice(): Notice {
  return { type: "error", kind: "generic" };
}

function errorNotice(error: unknown): Notice {
  if (!(error instanceof AiProviderConfigurationClientError)) {
    return genericErrorNotice();
  }

  return { type: "error", kind: error.code };
}

function noticeContent(notice: Notice, t: TFunction): string {
  if (notice.type === "success") {
    return t("ai_reviewer_provider_connection_successful");
  }

  switch (notice.kind) {
    case "AI_PROVIDER_AUTHENTICATION_ERROR":
      return t("ai_reviewer_error_provider_credentials_rejected");
    case "AI_PROVIDER_CONFIGURATION_PERSISTENCE_FAILED":
      return t("ai_reviewer_provider_configuration_persistence_failed");
    case "AI_PROVIDER_NETWORK_FAILED":
      return t("ai_reviewer_provider_network_failed");
    case "AI_PROVIDER_NOT_CONFIGURED":
      return t("ai_reviewer_provider_not_configured");
    case "AI_PROVIDER_RATE_LIMITED":
      return t("ai_reviewer_error_provider_rate_limited");
    case "AI_PROVIDER_SCHEMA_INVALID":
      return t("ai_reviewer_error_provider_invalid_stream");
    case "AI_REQUEST_TIMEOUT":
      return t("ai_reviewer_provider_request_timeout");
    case "AI_PROVIDER_ERROR":
      return t("ai_reviewer_provider_request_failed");
    case "generic":
      return t("ai_reviewer_provider_generic_error");
  }
}

export function AiIntegrationDetailsView({
  projectId,
  onHide,
  getConfiguration,
  saveConfiguration,
  testConnection,
}: Props) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState<
    AiProviderConfiguration | null | undefined
  >();
  const [classification, setClassification] = useState<
    "local" | "remote" | null
  >(null);
  const [draft, setDraft] = useState({ ...emptyConfiguration });
  const [busy, setBusy] = useState<OperationKind | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const operationRef = useRef<{
    generation: number;
    controller: AbortController | null;
  }>({ generation: 0, controller: null });

  const cancel = useCallback(() => {
    operationRef.current.controller?.abort();
    operationRef.current.controller = null;
    operationRef.current.generation += 1;
  }, []);

  const begin = useCallback((): Operation => {
    cancel();
    const operation = {
      generation: operationRef.current.generation,
      controller: new AbortController(),
    };
    operationRef.current.controller = operation.controller;
    return operation;
  }, [cancel]);

  const complete = useCallback((operation: Operation) => {
    if (
      operationRef.current.generation !== operation.generation ||
      operationRef.current.controller !== operation.controller ||
      operation.controller.signal.aborted
    ) {
      return false;
    }
    operationRef.current.controller = null;
    return true;
  }, []);

  const applyResponse = useCallback(
    (response: AiProviderConfigurationResponse) => {
      const next = response.config
        ? copyPublicConfiguration(response.config)
        : null;
      setSaved(next);
      setClassification(response.classification);
      setDraft(next ? draftFromConfiguration(next) : { ...emptyConfiguration });
      setBusy(null);
      setNotice(null);
    },
    [],
  );

  useEffect(() => {
    const operation = begin();
    setSaved(undefined);
    setClassification(null);
    setDraft({ ...emptyConfiguration });
    setBusy(null);
    setNotice(null);

    void getConfiguration(projectId, operation.controller.signal).then(
      (response) => complete(operation) && applyResponse(response),
      (error) => {
        if (complete(operation)) {
          setNotice(errorNotice(error));
        }
      },
    );
    return cancel;
  }, [applyResponse, begin, cancel, complete, getConfiguration, projectId]);

  const dirty =
    saved?.provider !== draft.provider ||
    saved?.model !== draft.model ||
    (saved?.contextLengthSource === "override"
      ? String(saved.contextLength)
      : "") !== draft.contextLengthOverride ||
    (draft.provider === "openai-compatible" &&
      (saved?.provider !== "openai-compatible" ||
        saved.baseUrl !== draft.baseUrl)) ||
    draft.credential !== "";
  const overrideText = draft.contextLengthOverride.trim();
  const parsedContextLengthOverride =
    overrideText === "" ? null : Number(overrideText);
  const validContextLengthOverride =
    parsedContextLengthOverride == null ||
    (Number.isSafeInteger(parsedContextLengthOverride) &&
      parsedContextLengthOverride > 0);
  const credentialAvailable =
    draft.provider === "openai-compatible" ||
    draft.credential.trim() !== "" ||
    (saved?.provider === draft.provider && saved.credentialSet);
  const credentialRequired =
    draft.provider !== "openai-compatible" &&
    !(saved?.provider === draft.provider && saved.credentialSet);
  const valid =
    (draft.provider !== "openai-compatible" || draft.baseUrl.trim() !== "") &&
    draft.model.trim() !== "" &&
    validContextLengthOverride &&
    credentialAvailable;
  const canSave = saved !== undefined && busy === null && dirty && valid;
  const canTest =
    saved != null && busy === null && !dirty && credentialAvailable;

  const updateDraft = (field: ConfigurationField, value: string) => {
    if (busy) cancel();
    setDraft((current) => ({
      ...current,
      [field]: value,
      ...(field === "baseUrl" || field === "model"
        ? { contextLengthOverride: "" }
        : {}),
    }));
    setBusy(null);
    setNotice(null);
  };

  const updateProvider = (value: string) => {
    const provider = providerFromValue(value);
    if (provider == null) return;
    if (busy) cancel();
    setDraft((current) => ({
      ...current,
      provider,
      credential: "",
      contextLengthOverride: "",
    }));
    setBusy(null);
    setNotice(null);
  };

  const run = <T,>(
    kind: OperationKind,
    request: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> => {
    const operation = begin();
    setBusy(kind);
    setNotice(null);
    return request(operation.controller.signal).then(
      (result) => (complete(operation) ? result : undefined),
      (error) => {
        if (complete(operation)) {
          setBusy(null);
          setNotice(errorNotice(error));
        }
        return undefined;
      },
    );
  };

  const handleSave = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave) return;
    const credential =
      draft.credential === "" ? {} : { credential: draft.credential };
    let requested: AiProviderConfigurationWrite;
    switch (draft.provider) {
      case "openai-compatible":
        requested = {
          provider: draft.provider,
          baseUrl: draft.baseUrl,
          model: draft.model,
          contextLengthOverride: parsedContextLengthOverride,
          ...credential,
        };
        break;
      case "gemini":
        requested = {
          provider: draft.provider,
          model: draft.model,
          contextLengthOverride: parsedContextLengthOverride,
          ...credential,
        };
        break;
      case "claude":
        requested = {
          provider: draft.provider,
          model: draft.model,
          contextLengthOverride: parsedContextLengthOverride,
          ...credential,
        };
        break;
    }
    void run("save", (signal) =>
      saveConfiguration(projectId, requested, signal),
    ).then((response) => {
      if (!response) return;
      if (response.config) {
        applyResponse(response);
      } else {
        setBusy(null);
        setNotice(genericErrorNotice());
      }
    });
  };

  const handleTest = () => {
    if (!canTest) return;
    void run("test", (signal) => testConnection(projectId, signal)).then(
      (response) => {
        if (!response) return;
        setBusy(null);
        setNotice({
          type: "success",
          kind: "connectionSuccessful",
        });
      },
    );
  };

  const handleHide = () => {
    cancel();
    onHide();
  };

  return (
    <OLModal
      show
      onHide={handleHide}
      dialogClassName="ai-reviewer-provider-settings"
    >
      <OLModalHeader
        closeButton
        closeLabel={t("ai_reviewer_provider_settings_close")}
        className="ai-reviewer-provider-settings-header"
      >
        <OLModalTitle>{t("ai_reviewer_title")}</OLModalTitle>
      </OLModalHeader>
      <OLForm
        onSubmit={handleSave}
        className="ai-reviewer-provider-settings-form"
      >
        <OLModalBody className="ai-reviewer-provider-settings-body">
          <OLFormGroup
            controlId="ai-reviewer-provider"
            className="ai-reviewer-provider-settings-field"
          >
            <OLFormLabel>{t("ai_reviewer_provider")}</OLFormLabel>
            <OLFormSelect
              value={draft.provider}
              onChange={(event) => updateProvider(event.target.value)}
              disabled={saved === undefined}
              className="ai-reviewer-provider-settings-control"
            >
              {providers.map((provider) => (
                <option key={provider} value={provider}>
                  {providerLabel(provider, t)}
                </option>
              ))}
            </OLFormSelect>
          </OLFormGroup>
          {fields
            .filter(
              (field) =>
                field !== "baseUrl" || draft.provider === "openai-compatible",
            )
            .map((field) => (
              <OLFormGroup
                key={field}
                controlId={`ai-reviewer-${field}`}
                className="ai-reviewer-provider-settings-field mt-3"
              >
                <OLFormLabel>{fieldLabel(field, t)}</OLFormLabel>
                <OLFormControl
                  type={field === "credential" ? "password" : "text"}
                  value={draft[field]}
                  onChange={(event) => updateDraft(field, event.target.value)}
                  disabled={saved === undefined}
                  autoComplete={field === "credential" ? "new-password" : "off"}
                  required={field === "credential" && credentialRequired}
                  aria-required={
                    field === "credential" ? credentialRequired : undefined
                  }
                  className="ai-reviewer-provider-settings-control"
                />
              </OLFormGroup>
            ))}
          <details className="ai-reviewer-provider-advanced mt-3">
            <summary className="ai-reviewer-provider-advanced-summary">
              {t("ai_reviewer_provider_advanced_settings")}
            </summary>
            <div className="ai-reviewer-provider-advanced-content mt-2">
              <OLFormGroup
                controlId="ai-reviewer-contextLengthOverride"
                className="ai-reviewer-provider-settings-field"
              >
                <OLFormLabel>
                  {fieldLabel("contextLengthOverride", t)}
                </OLFormLabel>
                <OLFormControl
                  type="number"
                  min={1}
                  step={1}
                  value={draft.contextLengthOverride}
                  onChange={(event) =>
                    updateDraft("contextLengthOverride", event.target.value)
                  }
                  disabled={saved === undefined}
                  autoComplete="off"
                  aria-describedby="ai-reviewer-contextLengthOverride-help"
                  className="ai-reviewer-provider-settings-control"
                />
                <p
                  id="ai-reviewer-contextLengthOverride-help"
                  className="ai-reviewer-provider-advanced-help mt-1 mb-0"
                >
                  {t("ai_reviewer_provider_context_length_override_help")}
                </p>
              </OLFormGroup>
            </div>
          </details>
          {saved && (
            <div className="ai-reviewer-provider-settings-details mt-3">
              <p className="ai-reviewer-provider-context-length mb-0">
                {t("ai_reviewer_provider_context_length_in_use", {
                  contextLength: saved.contextLength,
                })}
              </p>
              <p className="ai-reviewer-provider-context-length-source mt-1 mb-0">
                {contextLengthSourceLabel(saved.contextLengthSource, t)}
              </p>
              {classification && (
                <p className="ai-reviewer-provider-endpoint mt-1 mb-0">
                  {classification === "local"
                    ? t("ai_reviewer_provider_local")
                    : t("ai_reviewer_provider_remote")}
                </p>
              )}
              <p className="mt-1 mb-0">
                {saved.credentialSet
                  ? t("ai_reviewer_provider_credential_set")
                  : t("ai_reviewer_provider_credential_not_set")}
              </p>
              {saved.credentialUpdatedAt && (
                <time
                  className="d-block mt-1"
                  dateTime={saved.credentialUpdatedAt}
                  title={saved.credentialUpdatedAt}
                >
                  {t("ai_reviewer_last_updated", {
                    updatedAt: saved.credentialUpdatedAt,
                  })}
                </time>
              )}
            </div>
          )}
          {notice && (
            <OLNotification
              type={notice.type}
              content={noticeContent(notice, t)}
            />
          )}
        </OLModalBody>
        <OLModalFooter className="ai-reviewer-provider-settings-footer">
          <OLButton
            type="button"
            variant="secondary"
            onClick={handleTest}
            disabled={!canTest}
          >
            {t("ai_reviewer_provider_test_connection")}
          </OLButton>
          <OLButton type="submit" variant="primary" disabled={!canSave}>
            {t("ai_reviewer_provider_save")}
          </OLButton>
        </OLModalFooter>
      </OLForm>
    </OLModal>
  );
}

export default function AiIntegrationDetails({
  onHide,
}: {
  onHide: () => void;
}) {
  const { projectId } = useProjectContext();
  return (
    <AiIntegrationDetailsView
      projectId={projectId}
      onHide={onHide}
      getConfiguration={getAiProviderConfiguration}
      saveConfiguration={saveAiProviderConfiguration}
      testConnection={testAiProviderConnection}
    />
  );
}
