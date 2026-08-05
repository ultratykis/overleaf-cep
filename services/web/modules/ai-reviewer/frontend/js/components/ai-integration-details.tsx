import { useProjectContext } from "@/shared/context/project-context";
import OLButton from "@/shared/components/ol/ol-button";
import OLForm from "@/shared/components/ol/ol-form";
import OLFormControl from "@/shared/components/ol/ol-form-control";
import OLFormGroup from "@/shared/components/ol/ol-form-group";
import OLFormLabel from "@/shared/components/ol/ol-form-label";
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

import {
  AiProviderConfigurationClientError,
  type AiProviderConfiguration,
  type AiProviderConfigurationClientErrorCode,
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
  contextLength: string;
  credential: string;
};
type ConfigurationField = "baseUrl" | "model" | "contextLength" | "credential";

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
  contextLength: "",
  credential: "",
};

const fields: ConfigurationField[] = [
  "baseUrl",
  "model",
  "contextLength",
  "credential",
];

function draftFromConfiguration(
  configuration: AiProviderConfiguration,
): ConfigurationDraft {
  return {
    provider: configuration.provider,
    baseUrl: configuration.baseUrl,
    model: configuration.model,
    contextLength: String(configuration.contextLength),
    credential: "",
  };
}

function fieldLabel(field: ConfigurationField, t: TFunction): string {
  switch (field) {
    case "baseUrl":
      return t("ai_reviewer_provider_base_url");
    case "model":
      return t("ai_reviewer_provider_model");
    case "contextLength":
      return t("ai_reviewer_provider_context_length");
    case "credential":
      return t("ai_reviewer_provider_credential");
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
        ? {
            provider: response.config.provider,
            baseUrl: response.config.baseUrl,
            model: response.config.model,
            contextLength: response.config.contextLength,
            credentialSet: response.config.credentialSet,
            credentialUpdatedAt: response.config.credentialUpdatedAt,
          }
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
    saved?.baseUrl !== draft.baseUrl ||
    saved?.model !== draft.model ||
    (saved == null ? "" : String(saved.contextLength)) !==
      draft.contextLength ||
    draft.credential !== "";
  const parsedContextLength = Number(draft.contextLength);
  const valid =
    draft.baseUrl.trim() !== "" &&
    draft.model.trim() !== "" &&
    draft.contextLength.trim() !== "" &&
    Number.isSafeInteger(parsedContextLength) &&
    parsedContextLength > 0;
  const canSave = saved !== undefined && busy === null && dirty && valid;
  const canTest = saved != null && busy === null && !dirty;

  const updateDraft = (field: ConfigurationField, value: string) => {
    if (busy) cancel();
    setDraft((current) => ({ ...current, [field]: value }));
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
    const requested: AiProviderConfigurationWrite = {
      provider: draft.provider,
      baseUrl: draft.baseUrl,
      model: draft.model,
      contextLength: parsedContextLength,
    };
    if (draft.credential !== "") {
      requested.credential = draft.credential;
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
    <OLModal show onHide={handleHide}>
      <OLModalHeader
        closeButton
        closeLabel={t("ai_reviewer_provider_settings_close")}
      >
        <OLModalTitle>{t("ai_reviewer_title")}</OLModalTitle>
      </OLModalHeader>
      <OLForm onSubmit={handleSave}>
        <OLModalBody>
          <p className="mb-0">{t("ai_reviewer_provider_openai_compatible")}</p>
          {fields.map((field) => (
            <OLFormGroup
              key={field}
              controlId={`ai-reviewer-${field}`}
              className="mt-3"
            >
              <OLFormLabel>{fieldLabel(field, t)}</OLFormLabel>
              <OLFormControl
                type={
                  field === "contextLength"
                    ? "number"
                    : field === "credential"
                      ? "password"
                      : "text"
                }
                min={field === "contextLength" ? 1 : undefined}
                step={field === "contextLength" ? 1 : undefined}
                value={draft[field]}
                onChange={(event) => updateDraft(field, event.target.value)}
                disabled={saved === undefined}
                autoComplete={field === "credential" ? "new-password" : "off"}
              />
            </OLFormGroup>
          ))}
          {saved && (
            <div className="mt-3 text-break">
              {classification && (
                <p className="mb-0">
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
        <OLModalFooter>
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
