import { useProjectContext } from "@/shared/context/project-context";
import OLBadge from "@/shared/components/ol/ol-badge";
import OLButton from "@/shared/components/ol/ol-button";
import OLButtonGroup from "@/shared/components/ol/ol-button-group";
import OLCard from "@/shared/components/ol/ol-card";
import OLForm from "@/shared/components/ol/ol-form";
import OLFormControl from "@/shared/components/ol/ol-form-control";
import OLFormGroup from "@/shared/components/ol/ol-form-group";
import OLFormLabel from "@/shared/components/ol/ol-form-label";
import OLFormSelect from "@/shared/components/ol/ol-form-select";
import OLIconButton from "@/shared/components/ol/ol-icon-button";
import {
  OLModal,
  OLModalBody,
  OLModalFooter,
  OLModalHeader,
  OLModalTitle,
} from "@/shared/components/ol/ol-modal";
import OLNotification from "@/shared/components/ol/ol-notification";
import OLTable from "@/shared/components/ol/ol-table";
import GenericConfirmModal from "@/features/ide-react/components/modals/generic-confirm-modal";
import { formatTimeBasedOnYear } from "@/features/utils/format-date";
import type { TFunction } from "i18next";
import {
  type FormEvent,
  type ChangeEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import {
  deriveAiReviewerChatRequestUrl,
  normalizeAzureOpenAiEndpoint,
} from "../../../shared/provider-request-url.mjs";
import "../../stylesheets/ai-reviewer.scss";
import {
  AiProviderConfigurationClientError,
  type AiProvider,
  type AiProviderConfiguration,
  type AiProviderConfigurationClientErrorCode,
  type AiProviderConnection,
  type AiProviderConfigurationWrite,
  type AzureOpenAiRequestStyle,
  createAiProviderConnection,
  deleteAiProviderConnection,
  getAiProviderConnections,
  testAiProviderConnection,
  updateAiProviderConnection,
} from "../services/ai-provider-configuration";
import {
  AiReviewerSkillClientError,
  type AiReviewerSkill,
  type AiReviewerSkillUpload,
  deleteAiReviewerSkill,
  getAiReviewerSkills,
  uploadAiReviewerSkill,
} from "../services/ai-reviewer-skills";

type OperationKind = "save" | "test" | "connections";
type Operation = { generation: number; controller: AbortController };
type ConnectionFormMode = "create" | "edit" | "idle";
type PendingNavigation =
  | { kind: "add" }
  | { kind: "cancel" }
  | { kind: "close" }
  | { kind: "edit"; connectionId: string };
type Notice =
  | { type: "success"; kind: "connectionSuccessful" }
  | {
      type: "error";
      kind: "generic" | AiProviderConfigurationClientErrorCode;
    };
type ConfigurationDraft = {
  provider: AiProviderConfiguration["provider"];
  label: string;
  baseUrl: string;
  requestStyle: AzureOpenAiRequestStyle;
  apiVersion: string;
  deployments: string;
  contextLengthOverride: string;
  credential: string;
};
type ConfigurationField =
  | "label"
  | "baseUrl"
  | "apiVersion"
  | "deployments"
  | "contextLengthOverride"
  | "credential";

type Props = {
  projectId: string;
  onHide: () => void;
  listConnections: typeof getAiProviderConnections;
  createConnection: typeof createAiProviderConnection;
  updateConnection: typeof updateAiProviderConnection;
  deleteConnection: typeof deleteAiProviderConnection;
  testConnection: typeof testAiProviderConnection;
  listSkills: typeof getAiReviewerSkills;
  uploadSkill: typeof uploadAiReviewerSkill;
  deleteSkill: typeof deleteAiReviewerSkill;
};

const emptyConfiguration: ConfigurationDraft = {
  provider: "openai-compatible",
  label: "",
  baseUrl: "",
  requestStyle: "v1",
  apiVersion: "",
  deployments: "",
  contextLengthOverride: "",
  credential: "",
};

const fields: ConfigurationField[] = [
  "label",
  "baseUrl",
  "apiVersion",
  "deployments",
  "credential",
];

const providers: AiProvider[] = [
  "openai-compatible",
  "gemini",
  "claude",
  "azure",
];
const connectionLimit = 10;
const azureDeploymentName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const azureApiVersion = /^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/u;

function providerFromValue(value: string): AiProvider | null {
  switch (value) {
    case "openai-compatible":
    case "gemini":
    case "claude":
    case "azure":
      return value;
    default:
      return null;
  }
}

function copyPublicConfiguration(
  configuration: AiProviderConfiguration,
): AiProviderConfiguration {
  const common = {
    contextLengthOverride: configuration.contextLengthOverride,
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
    case "azure":
      return {
        provider: configuration.provider,
        baseUrl: configuration.baseUrl,
        requestStyle: configuration.requestStyle,
        ...(configuration.apiVersion === undefined
          ? {}
          : { apiVersion: configuration.apiVersion }),
        deployments: [...configuration.deployments],
        ...common,
      };
  }
}

function copyPublicConnection(
  connection: AiProviderConnection,
): AiProviderConnection {
  return {
    id: connection.id,
    revision: connection.revision,
    label: connection.label,
    classification: connection.classification,
    ...(connection.projectUseCount == null
      ? {}
      : { projectUseCount: connection.projectUseCount }),
    config: copyPublicConfiguration(connection.config),
  };
}

/**
 * A connection with no label of its own is served under a derived one, so the
 * field shows that name. Clearing the field asks the server to derive again.
 */
function draftFromConnection(
  connection: AiProviderConnection,
): ConfigurationDraft {
  const common = {
    label: connection.label,
    contextLengthOverride:
      connection.config.contextLengthOverride == null
        ? ""
        : String(connection.config.contextLengthOverride),
    credential: "",
  };
  switch (connection.config.provider) {
    case "openai-compatible":
      return {
        provider: connection.config.provider,
        baseUrl: connection.config.baseUrl,
        requestStyle: "v1",
        apiVersion: "",
        deployments: "",
        ...common,
      };
    case "gemini":
      return {
        provider: connection.config.provider,
        baseUrl: "",
        requestStyle: "v1",
        apiVersion: "",
        deployments: "",
        ...common,
      };
    case "claude":
      return {
        provider: connection.config.provider,
        baseUrl: "",
        requestStyle: "v1",
        apiVersion: "",
        deployments: "",
        ...common,
      };
    case "azure":
      return {
        provider: connection.config.provider,
        baseUrl: connection.config.baseUrl,
        requestStyle: connection.config.requestStyle,
        apiVersion: connection.config.apiVersion ?? "",
        deployments: connection.config.deployments.join("\n"),
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
    case "azure":
      return t("ai_reviewer_provider_azure");
  }
}

function providerTableLabel(provider: AiProvider, t: TFunction): string {
  if (provider === "openai-compatible") {
    return t("ai_reviewer_provider_openai_compatible_short");
  }
  return providerLabel(provider, t);
}

function fieldLabel(field: ConfigurationField, t: TFunction): string {
  switch (field) {
    case "label":
      return t("ai_reviewer_provider_label");
    case "baseUrl":
      return t("ai_reviewer_provider_base_url");
    case "apiVersion":
      return t("ai_reviewer_provider_azure_api_version");
    case "deployments":
      return t("ai_reviewer_provider_azure_deployments");
    case "contextLengthOverride":
      return t("ai_reviewer_provider_context_length_override");
    case "credential":
      return t("ai_reviewer_provider_credential");
  }
}

function deploymentNames(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((deployment) => deployment.trim())
    .filter((deployment) => deployment.length > 0);
}

function azurePortalEndpointFields(value: string) {
  try {
    const endpoint = normalizeAzureOpenAiEndpoint(value);
    return endpoint.deployment == null || endpoint.apiVersion == null
      ? null
      : endpoint;
  } catch {
    return null;
  }
}

function validDeploymentNames(deployments: string[]): boolean {
  return (
    deployments.length > 0 &&
    deployments.length <= 100 &&
    new Set(deployments).size === deployments.length &&
    deployments.every((deployment) => azureDeploymentName.test(deployment))
  );
}

function requestUrlsForDraft(
  draft: ConfigurationDraft,
  parsedDeployments: string[],
  openAiBaseUrlHasCompletionPath: boolean,
): string[] | null {
  try {
    if (draft.provider === "openai-compatible") {
      if (openAiBaseUrlHasCompletionPath) return null;
      return [
        deriveAiReviewerChatRequestUrl({
          provider: draft.provider,
          baseUrl: draft.baseUrl,
        }),
      ];
    }
    if (
      draft.provider !== "azure" ||
      !validDeploymentNames(parsedDeployments)
    ) {
      return null;
    }

    const endpoint = normalizeAzureOpenAiEndpoint(draft.baseUrl);
    const deployments =
      endpoint.deployment == null
        ? parsedDeployments
        : [
            endpoint.deployment,
            ...parsedDeployments.filter(
              (deployment) => deployment !== endpoint.deployment,
            ),
          ];
    if (!validDeploymentNames(deployments)) return null;

    const requestDeployments =
      draft.requestStyle === "deployment"
        ? deployments
        : deployments.slice(0, 1);
    return requestDeployments.map((model) =>
      deriveAiReviewerChatRequestUrl({
        provider: draft.provider,
        baseUrl: draft.baseUrl,
        requestStyle: draft.requestStyle,
        apiVersion: draft.apiVersion,
        model,
      }),
    );
  } catch {
    return null;
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
    case "AI_PROVIDER_CONFIGURATION_INVALID":
      return t("ai_reviewer_provider_configuration_invalid");
    case "AI_PROVIDER_CONFIGURATION_PERSISTENCE_FAILED":
      return t("ai_reviewer_provider_configuration_persistence_failed");
    case "AI_PROVIDER_CONNECTION_CONFLICT":
      return t("ai_reviewer_provider_connection_conflict");
    case "AI_PROVIDER_CONNECTION_LIMIT_REACHED":
      return t("ai_reviewer_connection_limit_reached");
    case "AI_PROVIDER_CONNECTION_NOT_FOUND":
      return t("ai_reviewer_connection_not_found");
    case "AI_PROVIDER_MODEL_DISCOVERY_UNSUPPORTED":
      return t("ai_reviewer_provider_models_unavailable");
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
  listConnections,
  createConnection,
  updateConnection,
  deleteConnection,
  testConnection,
  listSkills,
  uploadSkill,
  deleteSkill,
}: Props) {
  const { t } = useTranslation();
  const [connections, setConnections] = useState<
    AiProviderConnection[] | undefined
  >();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<ConnectionFormMode>("idle");
  const [draft, setDraft] = useState({ ...emptyConfiguration });
  const [pendingNavigation, setPendingNavigation] =
    useState<PendingNavigation | null>(null);
  const [pendingDeletion, setPendingDeletion] =
    useState<AiProviderConnection | null>(null);
  const [busy, setBusy] = useState<OperationKind | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [skills, setSkills] = useState<AiReviewerSkill[] | undefined>();
  const [skillBusy, setSkillBusy] = useState(false);
  const [skillNotice, setSkillNotice] = useState<string | null>(null);
  const skillOperationRef = useRef<AbortController | null>(null);
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

  const applyConnections = useCallback((list: AiProviderConnection[]) => {
    setConnections(list.map(copyPublicConnection));
    setSelectedId(null);
    setFormMode("idle");
    setDraft({ ...emptyConfiguration });
    setBusy(null);
    setNotice(null);
  }, []);

  useEffect(() => {
    const operation = begin();
    setConnections(undefined);
    setSelectedId(null);
    setFormMode("idle");
    setDraft({ ...emptyConfiguration });
    setPendingNavigation(null);
    setPendingDeletion(null);
    setBusy(null);
    setNotice(null);

    void listConnections(projectId, operation.controller.signal).then(
      (response) => {
        if (!complete(operation)) return;
        applyConnections(response.connections);
      },
      (error) => {
        if (complete(operation)) {
          setNotice(errorNotice(error));
        }
      },
    );
    return cancel;
  }, [applyConnections, begin, cancel, complete, listConnections, projectId]);

  useEffect(() => {
    skillOperationRef.current?.abort();
    const controller = new AbortController();
    skillOperationRef.current = controller;
    setSkills(undefined);
    setSkillBusy(false);
    setSkillNotice(null);
    void listSkills(projectId, controller.signal).then(
      (response) => {
        if (skillOperationRef.current !== controller) return;
        skillOperationRef.current = null;
        setSkills(response.skills);
      },
      (error) => {
        if (skillOperationRef.current !== controller) return;
        skillOperationRef.current = null;
        setSkills([]);
        setSkillNotice(
          error instanceof AiReviewerSkillClientError
            ? error.message
            : "The AI reviewer skills could not be loaded.",
        );
      },
    );
    return () => {
      controller.abort();
      // A file read can hand this slot to an upload before unmount or project
      // change; abort whichever request currently belongs to this view.
      skillOperationRef.current?.abort();
      skillOperationRef.current = null;
    };
  }, [listSkills, projectId]);

  const selected =
    connections?.find((entry) => entry.id === selectedId) ?? null;
  const saved =
    connections === undefined ? undefined : (selected?.config ?? null);
  const parsedDeployments = deploymentNames(draft.deployments);
  const editedDraftDirty =
    saved?.provider !== draft.provider ||
    (selected?.label ?? "") !== draft.label ||
    (saved?.contextLengthOverride == null
      ? ""
      : String(saved.contextLengthOverride)) !== draft.contextLengthOverride ||
    (draft.provider === "openai-compatible" &&
      (saved?.provider !== "openai-compatible" ||
        saved.baseUrl !== draft.baseUrl)) ||
    (draft.provider === "azure" &&
      (saved?.provider !== "azure" ||
        saved.baseUrl !== draft.baseUrl ||
        saved.requestStyle !== draft.requestStyle ||
        (draft.requestStyle === "deployment" &&
          (saved.apiVersion ?? "") !== draft.apiVersion) ||
        saved.deployments.join("\n") !== parsedDeployments.join("\n"))) ||
    draft.credential !== "";
  const newDraftDirty =
    draft.provider !== emptyConfiguration.provider ||
    fields.some((field) => draft[field] !== "") ||
    draft.contextLengthOverride !== "";
  const dirty =
    (formMode === "edit" && editedDraftDirty) ||
    (formMode === "create" && newDraftDirty);
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
  const validAzureDeployments = validDeploymentNames(parsedDeployments);
  const openAiBaseUrlHasCompletionPath =
    draft.provider === "openai-compatible" &&
    /\/chat\/completions\/?$/u.test(draft.baseUrl.trim());
  const requestUrls = requestUrlsForDraft(
    draft,
    parsedDeployments,
    openAiBaseUrlHasCompletionPath,
  );
  const valid =
    ((draft.provider !== "openai-compatible" && draft.provider !== "azure") ||
      draft.baseUrl.trim() !== "") &&
    (draft.provider !== "azure" ||
      (validAzureDeployments &&
        (draft.requestStyle === "v1" ||
          draft.apiVersion === "" ||
          azureApiVersion.test(draft.apiVersion)))) &&
    !openAiBaseUrlHasCompletionPath &&
    validContextLengthOverride &&
    credentialAvailable;
  const formEditable = formMode === "create" || formMode === "edit";
  const canSave =
    saved !== undefined && formEditable && busy === null && dirty && valid;
  const connectionLimitReached = (connections?.length ?? 0) >= connectionLimit;
  const updateDraft = (field: ConfigurationField, value: string) => {
    if (!formEditable) return;
    if (busy) cancel();
    setDraft((current) => {
      if (field === "baseUrl" && current.provider === "azure") {
        const portal = azurePortalEndpointFields(value);
        if (portal != null) {
          return {
            ...current,
            baseUrl: value,
            deployments: portal.deployment,
            ...(current.requestStyle === "deployment"
              ? { apiVersion: portal.apiVersion }
              : {}),
          };
        }
      }
      return { ...current, [field]: value };
    });
    setBusy(null);
    setNotice(null);
  };

  const updateAzureRequestStyle = (value: string) => {
    if (!formEditable || (value !== "v1" && value !== "deployment")) {
      return;
    }
    if (busy) cancel();
    setDraft((current) => ({
      ...current,
      requestStyle: value,
      ...(value === "v1"
        ? { apiVersion: "" }
        : {
            apiVersion:
              azurePortalEndpointFields(current.baseUrl)?.apiVersion ??
              current.apiVersion,
          }),
    }));
    setBusy(null);
    setNotice(null);
  };

  const updateProvider = (value: string) => {
    if (formMode !== "create") return;
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
    const label = draft.label.trim();
    let requested: AiProviderConfigurationWrite;
    switch (draft.provider) {
      case "openai-compatible":
        requested = {
          provider: draft.provider,
          baseUrl: draft.baseUrl,
          label,
          contextLengthOverride: parsedContextLengthOverride,
          ...credential,
        };
        break;
      case "gemini":
        requested = {
          provider: draft.provider,
          label,
          contextLengthOverride: parsedContextLengthOverride,
          ...credential,
        };
        break;
      case "claude":
        requested = {
          provider: draft.provider,
          label,
          contextLengthOverride: parsedContextLengthOverride,
          ...credential,
        };
        break;
      case "azure":
        requested = {
          provider: draft.provider,
          baseUrl: draft.baseUrl,
          requestStyle: draft.requestStyle,
          ...(draft.requestStyle === "deployment" && draft.apiVersion !== ""
            ? { apiVersion: draft.apiVersion }
            : {}),
          deployments: parsedDeployments,
          label,
          contextLengthOverride: parsedContextLengthOverride,
          ...credential,
        };
        break;
    }
    const editedId = selectedId;
    const editedRevision = selected?.revision;
    if (editedId != null && editedRevision == null) return;
    void run("save", (signal) =>
      editedId == null
        ? createConnection(projectId, requested, signal)
        : updateConnection(
            projectId,
            editedId,
            editedRevision as number,
            requested,
            signal,
          ),
    ).then((connection) => {
      if (!connection) return;
      if (connection.config == null) {
        setBusy(null);
        setNotice(genericErrorNotice());
        return;
      }
      // A write returns only the written connection, so retain the usage count
      // from the listing while splicing it into place.
      const connectionWithUsage = {
        ...connection,
        projectUseCount:
          connection.projectUseCount ??
          (editedId == null ? 0 : selected?.projectUseCount),
      };
      applyConnections(
        editedId == null
          ? [...(connections ?? []), connectionWithUsage]
          : (connections ?? []).map((entry) =>
              entry.id === connection.id ? connectionWithUsage : entry,
            ),
      );
    });
  };

  const canTestConnection = (connection: AiProviderConnection) =>
    !formEditable &&
    busy === null &&
    (connection.config.provider === "openai-compatible" ||
      connection.config.credentialSet);

  const handleTest = (connection: AiProviderConnection) => {
    if (!canTestConnection(connection)) return;
    void run("test", (signal) =>
      testConnection(projectId, connection.id, signal),
    ).then((response) => {
      if (!response) return;
      setBusy(null);
      setNotice({
        type: "success",
        kind: "connectionSuccessful",
      });
    });
  };

  const performNavigation = (navigation: PendingNavigation) => {
    if (navigation.kind === "close") {
      cancel();
      skillOperationRef.current?.abort();
      skillOperationRef.current = null;
      onHide();
      return;
    }
    if (navigation.kind === "cancel") {
      if (busy) cancel();
      setSelectedId(null);
      setFormMode("idle");
      setDraft({ ...emptyConfiguration });
      setBusy(null);
      setNotice(null);
      return;
    }
    if (navigation.kind === "add") {
      if (connectionLimitReached) return;
      if (busy) cancel();
      setSelectedId(null);
      setFormMode("create");
      setDraft({ ...emptyConfiguration });
      setBusy(null);
      setNotice(null);
      return;
    }
    const connection = connections?.find(
      (entry) => entry.id === navigation.connectionId,
    );
    if (connection == null) return;
    if (busy) cancel();
    setSelectedId(connection.id);
    setFormMode("edit");
    setDraft(draftFromConnection(connection));
    setBusy(null);
    setNotice(null);
  };

  const requestNavigation = (navigation: PendingNavigation) => {
    if (
      navigation.kind === "edit" &&
      navigation.connectionId === selectedId &&
      formMode === "edit"
    ) {
      return;
    }
    if (dirty) {
      setPendingNavigation(navigation);
      return;
    }
    performNavigation(navigation);
  };

  const handleDelete = (connection: AiProviderConnection) => {
    if (busy !== null) return;
    setPendingDeletion(connection);
  };

  const confirmDelete = () => {
    const connection = pendingDeletion;
    if (connection == null || busy !== null) return;
    setPendingDeletion(null);
    void run("connections", (signal) =>
      deleteConnection(projectId, connection.id, connection.revision, signal),
    ).then((response) => {
      if (!response) return;
      applyConnections(response.connections);
    });
  };

  const runSkillRequest = <T,>(
    request: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> => {
    skillOperationRef.current?.abort();
    const controller = new AbortController();
    skillOperationRef.current = controller;
    setSkillBusy(true);
    setSkillNotice(null);
    return request(controller.signal).then(
      (result) => {
        if (skillOperationRef.current !== controller) return undefined;
        skillOperationRef.current = null;
        setSkillBusy(false);
        return result;
      },
      (error) => {
        if (skillOperationRef.current !== controller) return undefined;
        skillOperationRef.current = null;
        setSkillBusy(false);
        setSkillNotice(
          error instanceof AiReviewerSkillClientError
            ? error.message
            : "The AI reviewer skill request failed.",
        );
        return undefined;
      },
    );
  };

  const handleSkillUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const selectedFiles = Array.from(input.files ?? []);
    input.value = "";
    if (selectedFiles.length === 0 || skillBusy) return;

    const skillFiles = selectedFiles.filter(
      (file) => file.name.toLowerCase() === "skill.md",
    );
    if (skillFiles.length !== 1) {
      setSkillNotice("Select exactly one SKILL.md file.");
      return;
    }
    const referenceFiles = selectedFiles.filter(
      (file) => file !== skillFiles[0],
    );
    if (
      referenceFiles.some((file) => !file.name.toLowerCase().endsWith(".md"))
    ) {
      setSkillNotice("Reference files must be Markdown files.");
      return;
    }

    let upload: AiReviewerSkillUpload;
    try {
      const contents = await Promise.all(
        selectedFiles.map((file) => file.text()),
      );
      const references: Record<string, string> = {};
      for (const [index, file] of selectedFiles.entries()) {
        if (file === skillFiles[0]) continue;
        const relativePath = file.webkitRelativePath || file.name;
        if (Object.hasOwn(references, relativePath)) {
          setSkillNotice(`The reference path ${relativePath} is duplicated.`);
          return;
        }
        references[relativePath] = contents[index];
      }
      upload = {
        skillMarkdown: contents[selectedFiles.indexOf(skillFiles[0])],
        referenceFiles: references,
      };
    } catch {
      setSkillNotice("The selected Markdown files could not be read.");
      return;
    }

    const created = await runSkillRequest((signal) =>
      uploadSkill(projectId, upload, signal),
    );
    if (created) {
      setSkills((current) => [...(current ?? []), created]);
    }
  };

  const handleSkillDelete = (skill: AiReviewerSkill) => {
    if (skillBusy) return;
    void runSkillRequest((signal) =>
      deleteSkill(projectId, skill.id, signal),
    ).then((response) => {
      if (response) setSkills(response.skills);
    });
  };

  const handleHide = () => {
    requestNavigation({ kind: "close" });
  };

  const providerHelp = [
    formMode === "edit" ? "ai-reviewer-connection-form-help" : null,
    draft.provider === "azure" ? "ai-reviewer-azure-provider-help" : null,
  ]
    .filter((value): value is string => value != null)
    .join(" ");

  const settingsModal = (
    <OLModal
      show
      scrollable
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
      <OLModalBody className="ai-reviewer-provider-settings-body">
        <section
          className="ai-reviewer-connections"
          aria-labelledby="ai-reviewer-connections-heading"
        >
          <h3 id="ai-reviewer-connections-heading" className="h5">
            {t("ai_reviewer_connections")}
          </h3>
          {connections != null && connections.length > 0 && (
            <div className="ai-reviewer-connection-table-scroll">
              <OLTable
                container={false}
                className="ai-reviewer-connection-table"
                aria-label={t("ai_reviewer_connections")}
              >
                <colgroup>
                  <col className="ai-reviewer-connection-name-column" />
                  <col className="ai-reviewer-connection-credential-column" />
                  <col className="ai-reviewer-connection-actions-column" />
                </colgroup>
                <thead>
                  <tr>
                    {/* "Display name" is what the form calls the field the user
                        types into. As a column heading it names the wrong thing:
                        this column identifies the destination. */}
                    <th scope="col">{t("ai_reviewer_provider")}</th>
                    <th scope="col">{t("ai_reviewer_provider_credential")}</th>
                    <th scope="col">
                      <span className="visually-hidden">{t("actions")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {connections.map((connection) => (
                    <tr
                      key={connection.id}
                      className="ai-reviewer-connection-row"
                      data-testid="ai-reviewer-connection-row"
                    >
                      {/* The name and its provider are one fact about one
                          destination, so they share a column. Whether the
                          endpoint is loopback or not still drives policy, but
                          it means nothing to a reader: both are reached over
                          the network. */}
                      <th
                        scope="row"
                        className="ai-reviewer-connection-name-cell"
                      >
                        <span
                          className="ai-reviewer-connection-name"
                          title={connection.label}
                        >
                          {connection.label}
                        </span>
                        <span className="ai-reviewer-connection-provider">
                          {providerTableLabel(connection.config.provider, t)}
                        </span>
                      </th>
                      <td className="ai-reviewer-connection-credential-cell">
                        <OLBadge
                          bg={
                            connection.config.credentialSet
                              ? "success"
                              : "secondary"
                          }
                        >
                          {connection.config.credentialSet
                            ? t("ai_reviewer_provider_credential_set")
                            : t("ai_reviewer_provider_credential_not_set")}
                        </OLBadge>
                        {connection.config.credentialUpdatedAt && (
                          <time
                            dateTime={connection.config.credentialUpdatedAt}
                            title={connection.config.credentialUpdatedAt}
                          >
                            {t("ai_reviewer_last_updated", {
                              updatedAt: formatTimeBasedOnYear(
                                connection.config.credentialUpdatedAt,
                              ),
                            })}
                          </time>
                        )}
                      </td>
                      <td className="ai-reviewer-connection-actions-cell">
                        <OLButtonGroup aria-label={t("actions")}>
                          <OLIconButton
                            type="button"
                            size="sm"
                            variant="secondary"
                            icon="network_check"
                            accessibilityLabel={t(
                              "ai_reviewer_connection_test_named",
                              { connection: connection.label },
                            )}
                            disabled={!canTestConnection(connection)}
                            onClick={() => handleTest(connection)}
                          />
                          <OLIconButton
                            type="button"
                            size="sm"
                            variant="secondary"
                            icon="edit"
                            accessibilityLabel={t(
                              "ai_reviewer_connection_edit_named",
                              { connection: connection.label },
                            )}
                            disabled={busy !== null}
                            onClick={() =>
                              requestNavigation({
                                kind: "edit",
                                connectionId: connection.id,
                              })
                            }
                          />
                          <OLIconButton
                            type="button"
                            size="sm"
                            variant="danger"
                            icon="delete"
                            accessibilityLabel={t(
                              "ai_reviewer_connection_delete_named",
                              { connection: connection.label },
                            )}
                            disabled={busy !== null}
                            onClick={() => handleDelete(connection)}
                          />
                        </OLButtonGroup>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </OLTable>
            </div>
          )}
          {connections != null && (
            <div className="ai-reviewer-connection-footer">
              <span>
                {t("ai_reviewer_connection_count", {
                  count: connections.length,
                  limit: connectionLimit,
                })}
              </span>
              <OLButton
                type="button"
                variant="link"
                className="btn-inline-link ai-reviewer-connection-add"
                disabled={busy !== null || connectionLimitReached}
                aria-describedby={
                  connectionLimitReached
                    ? "ai-reviewer-connection-limit-help"
                    : undefined
                }
                onClick={() => requestNavigation({ kind: "add" })}
              >
                {t("ai_reviewer_connection_add")}
              </OLButton>
            </div>
          )}
          {connectionLimitReached && (
            <p
              id="ai-reviewer-connection-limit-help"
              className="ai-reviewer-provider-settings-hint"
            >
              {t("ai_reviewer_connection_limit_reached")}
            </p>
          )}
          {!formEditable && notice && (
            <OLNotification
              type={notice.type}
              content={noticeContent(notice, t)}
            />
          )}
        </section>

        {formEditable && (
          <OLCard className="ai-reviewer-provider-form-card">
            <OLForm
              onSubmit={handleSave}
              className="ai-reviewer-provider-settings-form"
            >
              <h3 className="h5 ai-reviewer-provider-form-heading">
                {formMode === "create"
                  ? t("ai_reviewer_connection_add")
                  : t("ai_reviewer_connection_edit_heading", {
                      connection: selected?.label ?? "",
                    })}
              </h3>
              <p
                id="ai-reviewer-connection-form-help"
                className="ai-reviewer-provider-settings-state"
              >
                {formMode === "create"
                  ? t("ai_reviewer_connection_create_help")
                  : t("ai_reviewer_connection_edit_help")}
              </p>
              <OLFormGroup
                controlId="ai-reviewer-provider"
                className="ai-reviewer-provider-settings-field"
              >
                <OLFormLabel>{t("ai_reviewer_provider")}</OLFormLabel>
                <OLFormSelect
                  value={draft.provider}
                  onChange={(event) => updateProvider(event.target.value)}
                  disabled={saved === undefined || formMode !== "create"}
                  aria-describedby={providerHelp || undefined}
                  className="ai-reviewer-provider-settings-control"
                >
                  {providers.map((provider) => (
                    <option key={provider} value={provider}>
                      {providerLabel(provider, t)}
                    </option>
                  ))}
                </OLFormSelect>
                {draft.provider === "azure" && (
                  <p
                    id="ai-reviewer-azure-provider-help"
                    className="ai-reviewer-provider-advanced-help mt-1 mb-0"
                  >
                    {t("ai_reviewer_provider_azure_help")}
                  </p>
                )}
              </OLFormGroup>
              {draft.provider === "azure" && (
                <OLFormGroup
                  controlId="ai-reviewer-requestStyle"
                  className="ai-reviewer-provider-settings-field mt-3"
                >
                  <OLFormLabel>
                    {t("ai_reviewer_provider_azure_request_style")}
                  </OLFormLabel>
                  <OLFormSelect
                    value={draft.requestStyle}
                    onChange={(event) =>
                      updateAzureRequestStyle(event.target.value)
                    }
                    disabled={saved === undefined || !formEditable}
                    className="ai-reviewer-provider-settings-control"
                  >
                    <option value="v1">
                      {t("ai_reviewer_provider_azure_request_style_v1")}
                    </option>
                    <option value="deployment">
                      {t("ai_reviewer_provider_azure_request_style_deployment")}
                    </option>
                  </OLFormSelect>
                </OLFormGroup>
              )}
              {fields
                .filter(
                  (field) =>
                    (field !== "baseUrl" ||
                      draft.provider === "openai-compatible" ||
                      draft.provider === "azure") &&
                    (field !== "apiVersion" ||
                      (draft.provider === "azure" &&
                        draft.requestStyle === "deployment")) &&
                    (field !== "deployments" || draft.provider === "azure"),
                )
                .map((field) => (
                  <OLFormGroup
                    key={field}
                    controlId={`ai-reviewer-${field}`}
                    className="ai-reviewer-provider-settings-field mt-3"
                  >
                    <OLFormLabel>
                      {field === "baseUrl" && draft.provider === "azure"
                        ? t("ai_reviewer_provider_azure_endpoint")
                        : fieldLabel(field, t)}
                      {field === "apiVersion" && (
                        <>
                          {" "}
                          <span className="fw-normal">({t("optional")})</span>
                        </>
                      )}
                    </OLFormLabel>
                    <OLFormControl
                      as={field === "deployments" ? "textarea" : undefined}
                      type={field === "credential" ? "password" : "text"}
                      value={draft[field]}
                      onChange={(event) =>
                        updateDraft(field, event.target.value)
                      }
                      disabled={saved === undefined || !formEditable}
                      autoComplete={
                        field === "credential" ? "new-password" : "off"
                      }
                      placeholder={
                        field === "baseUrl" &&
                        draft.provider === "openai-compatible"
                          ? "http://127.0.0.1:11434/v1"
                          : undefined
                      }
                      aria-describedby={
                        field === "apiVersion"
                          ? "ai-reviewer-apiVersion-help"
                          : field === "baseUrl" &&
                              draft.provider === "openai-compatible"
                            ? `ai-reviewer-baseUrl-help${
                                openAiBaseUrlHasCompletionPath
                                  ? " ai-reviewer-baseUrl-error"
                                  : ""
                              }`
                            : field === "baseUrl" && draft.provider === "azure"
                              ? "ai-reviewer-azure-endpoint-help"
                              : undefined
                      }
                      aria-invalid={
                        field === "baseUrl" && openAiBaseUrlHasCompletionPath
                          ? true
                          : undefined
                      }
                      required={field === "credential" && credentialRequired}
                      aria-required={
                        field === "credential" ? credentialRequired : undefined
                      }
                      className="ai-reviewer-provider-settings-control"
                    />
                    {field === "apiVersion" && (
                      <p
                        id="ai-reviewer-apiVersion-help"
                        className="ai-reviewer-provider-advanced-help mt-1 mb-0"
                      >
                        {t("ai_reviewer_provider_azure_api_version_help")}
                      </p>
                    )}
                    {field === "baseUrl" &&
                      draft.provider === "openai-compatible" && (
                        <>
                          <p
                            id="ai-reviewer-baseUrl-help"
                            className="ai-reviewer-provider-advanced-help mt-1 mb-0"
                          >
                            {t("ai_reviewer_provider_base_url_help")}
                          </p>
                          {openAiBaseUrlHasCompletionPath && (
                            <p
                              id="ai-reviewer-baseUrl-error"
                              className="form-text text-danger mt-1 mb-0"
                              role="alert"
                            >
                              {t(
                                "ai_reviewer_provider_base_url_chat_completions_error",
                              )}
                            </p>
                          )}
                        </>
                      )}
                    {field === "baseUrl" && draft.provider === "azure" && (
                      <p
                        id="ai-reviewer-azure-endpoint-help"
                        className="ai-reviewer-provider-advanced-help mt-1 mb-0"
                      >
                        {t("ai_reviewer_provider_azure_endpoint_help")}
                      </p>
                    )}
                  </OLFormGroup>
                ))}
              {(draft.provider === "openai-compatible" ||
                draft.provider === "azure") && (
                <p
                  className="ai-reviewer-provider-request-preview mt-3 mb-0"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  <span>{t("ai_reviewer_provider_request_url")}</span>
                  {requestUrls == null ? (
                    <span className="ai-reviewer-provider-request-url">
                      {t("ai_reviewer_provider_request_url_unavailable")}
                    </span>
                  ) : (
                    requestUrls.map((requestUrl) => (
                      <span
                        key={requestUrl}
                        className="ai-reviewer-provider-request-url"
                        title={requestUrl}
                      >
                        {requestUrl}
                      </span>
                    ))
                  )}
                </p>
              )}
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
                      disabled={saved === undefined || !formEditable}
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
              {notice && (
                <OLNotification
                  type={notice.type}
                  content={noticeContent(notice, t)}
                />
              )}
              <div className="ai-reviewer-provider-form-actions">
                {busy === null && (
                  <span
                    className="ai-reviewer-provider-settings-hint"
                    data-testid="ai-reviewer-unsaved-hint"
                  >
                    {t("ai_reviewer_provider_save_before_checking")}
                  </span>
                )}
                <OLButtonGroup>
                  <OLButton
                    type="button"
                    variant="secondary"
                    onClick={() => requestNavigation({ kind: "cancel" })}
                  >
                    {t("cancel")}
                  </OLButton>
                  <OLButton type="submit" variant="primary" disabled={!canSave}>
                    {t("ai_reviewer_provider_save")}
                  </OLButton>
                </OLButtonGroup>
              </div>
            </OLForm>
          </OLCard>
        )}

        <section
          className="ai-reviewer-skills"
          aria-labelledby="ai-reviewer-skills-heading"
        >
          <h3 id="ai-reviewer-skills-heading" className="h5">
            {t("ai_reviewer_skills", "Skills")}
          </h3>
          {skills != null && skills.length > 0 && (
            <ul
              className="ai-reviewer-skill-list"
              aria-label={t("ai_reviewer_skills", "Skills")}
            >
              {skills.map((skill) => (
                <li
                  key={skill.id}
                  className="ai-reviewer-skill-row"
                  data-testid="ai-reviewer-skill-row"
                >
                  <div className="ai-reviewer-skill-summary">
                    <strong>{skill.name}</strong>
                    <p className="mb-0">{skill.description}</p>
                  </div>
                  <OLButton
                    type="button"
                    variant="link"
                    className="btn-inline-link ai-reviewer-skill-delete"
                    disabled={skillBusy}
                    aria-label={`${t("delete")} ${skill.name}`}
                    onClick={() => handleSkillDelete(skill)}
                  >
                    {t("delete")}
                  </OLButton>
                </li>
              ))}
            </ul>
          )}
          <OLFormGroup
            controlId="ai-reviewer-skill-files"
            className="ai-reviewer-skill-upload mt-2"
          >
            <OLFormLabel>
              {t(
                "ai_reviewer_skill_upload_label",
                "Upload SKILL.md and optional reference Markdown files",
              )}
            </OLFormLabel>
            <OLFormControl
              type="file"
              accept=".md,text/markdown"
              multiple
              disabled={skills === undefined || skillBusy}
              onChange={handleSkillUpload}
            />
          </OLFormGroup>
          {skillNotice && <OLNotification type="error" content={skillNotice} />}
        </section>
      </OLModalBody>
      <OLModalFooter className="ai-reviewer-provider-settings-footer">
        <OLButton type="button" variant="secondary" onClick={handleHide}>
          {t("ai_reviewer_provider_settings_close")}
        </OLButton>
      </OLModalFooter>
    </OLModal>
  );

  return (
    <>
      {settingsModal}
      {pendingNavigation != null && (
        <GenericConfirmModal
          show
          title={t("ai_reviewer_discard_connection_changes_title")}
          message={t("ai_reviewer_discard_connection_changes_message")}
          confirmLabel={t("ai_reviewer_discard_connection_changes")}
          primaryVariant="danger"
          onHide={() => setPendingNavigation(null)}
          onConfirm={() => {
            const navigation = pendingNavigation;
            setPendingNavigation(null);
            performNavigation(navigation);
          }}
        />
      )}
      {pendingDeletion != null && (
        <GenericConfirmModal
          show
          title={t("ai_reviewer_connection_delete_confirmation_title")}
          message={
            pendingDeletion.projectUseCount == null
              ? t("ai_reviewer_connection_delete_confirmation_message")
              : t(
                  "ai_reviewer_connection_delete_confirmation_message_with_count",
                  { count: pendingDeletion.projectUseCount },
                )
          }
          confirmLabel={t("delete")}
          primaryVariant="danger"
          onHide={() => setPendingDeletion(null)}
          onConfirm={confirmDelete}
        />
      )}
    </>
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
      listConnections={getAiProviderConnections}
      createConnection={createAiProviderConnection}
      updateConnection={updateAiProviderConnection}
      deleteConnection={deleteAiProviderConnection}
      testConnection={testAiProviderConnection}
      listSkills={getAiReviewerSkills}
      uploadSkill={uploadAiReviewerSkill}
      deleteSkill={deleteAiReviewerSkill}
    />
  );
}
