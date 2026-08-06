import { useProjectContext } from "@/shared/context/project-context";
import OLBadge from "@/shared/components/ol/ol-badge";
import OLButton from "@/shared/components/ol/ol-button";
import OLButtonGroup from "@/shared/components/ol/ol-button-group";
import OLCard from "@/shared/components/ol/ol-card";
import OLForm from "@/shared/components/ol/ol-form";
import OLFormCheckbox from "@/shared/components/ol/ol-form-checkbox";
import OLFormControl from "@/shared/components/ol/ol-form-control";
import OLFormGroup from "@/shared/components/ol/ol-form-group";
import OLFormLabel from "@/shared/components/ol/ol-form-label";
import OLFormSelect from "@/shared/components/ol/ol-form-select";
import OLFormText from "@/shared/components/ol/ol-form-text";
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
import { Nav, TabContainer, TabContent, TabPane } from "react-bootstrap";
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
  isPlaintextAiProviderBaseUrl,
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
  createUserAiProviderConnection,
  deleteAiProviderConnection,
  deleteUserAiProviderConnection,
  getAiProviderConnections,
  getUserAiProviderConnections,
  testAiProviderConnection,
  updateAiProviderConnection,
  updateUserAiProviderConnection,
} from "../services/ai-provider-configuration";
import {
  AiReviewerSkillClientError,
  type AiReviewerSkill,
  type AiReviewerSkillGitHostType,
  type AiReviewerSkillGitPreview,
  type AiReviewerSkillGitSkippedPluginReason,
  type AiReviewerSkillGitSkippedReferenceReason,
  type AiReviewerSkillGitSource,
  type AiReviewerSkillUpload,
  confirmAiReviewerSkillGitImport,
  confirmUserAiReviewerSkillGitImport,
  deleteAiReviewerSkill,
  deleteUserAiReviewerSkill,
  getAiReviewerSkills,
  getUserAiReviewerSkills,
  previewAiReviewerSkillGitImport,
  previewUserAiReviewerSkillGitImport,
  uploadAiReviewerSkill,
  uploadUserAiReviewerSkill,
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
  models: string;
  contextLengthOverride: string;
  reasoningModelCompatibility: boolean;
  credential: string;
};
type ConfigurationField =
  | "label"
  | "baseUrl"
  | "apiVersion"
  | "deployments"
  | "models"
  | "contextLengthOverride"
  | "credential";

type Props = {
  scopeKey: string;
  onHide: (connectionsChanged: boolean) => void;
  listConnections: typeof getAiProviderConnections;
  createConnection: typeof createAiProviderConnection;
  updateConnection: typeof updateAiProviderConnection;
  deleteConnection: typeof deleteAiProviderConnection;
  testConnection: typeof testAiProviderConnection;
  connectionTestEnabled?: boolean;
  listSkills: typeof getAiReviewerSkills;
  uploadSkill: typeof uploadAiReviewerSkill;
  previewSkillGitImport: typeof previewAiReviewerSkillGitImport;
  confirmSkillGitImport: typeof confirmAiReviewerSkillGitImport;
  deleteSkill: typeof deleteAiReviewerSkill;
};

const emptyConfiguration: ConfigurationDraft = {
  provider: "openai-compatible",
  label: "",
  baseUrl: "",
  requestStyle: "v1",
  apiVersion: "",
  deployments: "",
  models: "",
  contextLengthOverride: "",
  reasoningModelCompatibility: false,
  credential: "",
};

const fields: ConfigurationField[] = [
  "label",
  "baseUrl",
  "apiVersion",
  "deployments",
  "models",
  "credential",
];

const providers: AiProvider[] = [
  "openai-compatible",
  "gemini",
  "claude",
  "azure",
];
const connectionLimit = 10;
const skillCountLimit = 20;
const emptySkillGitSource: AiReviewerSkillGitSource = {
  repository: "",
  gitHostType: "auto",
  ref: "",
};
const azureDeploymentName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const azureApiVersion = /^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/u;
const openAiCompatibleApiVersion = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:-preview)?$/u;

function skippedReferenceReasonTranslation(
  reason: AiReviewerSkillGitSkippedReferenceReason,
) {
  switch (reason) {
    case "outside-skill-directory":
      return "ai_reviewer_skill_git_skip_outside_directory";
    case "not-reference-file":
      return "ai_reviewer_skill_git_skip_not_reference";
    case "not-readable":
      return "ai_reviewer_skill_git_skip_not_readable";
    case "size-limit":
      return "ai_reviewer_skill_git_skip_size_limit";
  }
}

function skippedPluginReasonTranslation(
  reason: AiReviewerSkillGitSkippedPluginReason,
) {
  switch (reason) {
    case "external-source":
      return "ai_reviewer_skill_git_skip_external_plugin";
    case "invalid-plugin":
      return "ai_reviewer_skill_git_skip_invalid_plugin";
    case "no-readable-skills":
      return "ai_reviewer_skill_git_skip_no_skills";
    case "skill-not-readable":
      return "ai_reviewer_skill_git_skip_unreadable_skill";
    case "duplicate-skill":
      return "ai_reviewer_skill_git_skip_duplicate_skill";
  }
}

function repositoryNeedsHostType(repository: string) {
  try {
    const url = new URL(repository);
    return !["github.com", "gitlab.com"].includes(url.hostname);
  } catch {
    return false;
  }
}

type AiReviewerSkillGroup =
  | {
      kind: "git";
      key: string;
      name: string;
      provenance: NonNullable<AiReviewerSkill["provenance"]>;
      ownerNames: string[];
      pluginVersions: string[];
      licenses: string[];
      skills: AiReviewerSkill[];
    }
  | {
      kind: "local";
      key: "local-files";
      name: "Local files";
      skills: AiReviewerSkill[];
    };

function repositoryName(repository: string) {
  const parts = repository.split("/").filter(Boolean);
  return (parts[parts.length - 1] ?? repository).replace(/\.git$/u, "");
}

function addDistinctMetadata(values: string[], value: string | undefined) {
  const storedValue = value ?? "";
  if (!values.includes(storedValue)) values.push(storedValue);
}

function storedSkillGroupMetadata(values: string[], unknown: string) {
  return values.map((value) => value || unknown).join(", ");
}

function storedSkillGroups(skills: AiReviewerSkill[]): AiReviewerSkillGroup[] {
  const groups = new Map<string, AiReviewerSkillGroup>();
  for (const skill of skills) {
    const provenance = skill.provenance;
    if (provenance == null) {
      const current = groups.get("local-files");
      if (current?.kind === "local") {
        current.skills.push(skill);
      } else {
        groups.set("local-files", {
          kind: "local",
          key: "local-files",
          name: "Local files",
          skills: [skill],
        });
      }
      continue;
    }

    // A repository may declare several plugins, so pluginName remains part of
    // source identity. Different commits of that same plugin stay together;
    // any differing saved terms are all shown in the group header.
    const key = JSON.stringify([
      "git",
      provenance.service,
      provenance.host,
      provenance.repository,
      provenance.pluginName ?? null,
    ]);
    const current = groups.get(key);
    if (current?.kind === "git") {
      current.skills.push(skill);
      addDistinctMetadata(current.ownerNames, provenance.owner?.name);
      addDistinctMetadata(current.pluginVersions, provenance.pluginVersion);
      addDistinctMetadata(current.licenses, provenance.license);
    } else {
      groups.set(key, {
        kind: "git",
        key,
        name: provenance.pluginName ?? repositoryName(provenance.repository),
        provenance,
        ownerNames: [provenance.owner?.name ?? ""],
        pluginVersions: [provenance.pluginVersion ?? ""],
        licenses: [provenance.license ?? ""],
        skills: [skill],
      });
    }
  }
  return Array.from(groups.values());
}

function storedSkillCount(count: number) {
  return `${count} ${count === 1 ? "skill" : "skills"}`;
}

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

function isPlaintextProviderBaseUrl(baseUrl: string): boolean {
  try {
    return isPlaintextAiProviderBaseUrl(baseUrl);
  } catch {
    return false;
  }
}

function isPlaintextProviderConfiguration(
  configuration: AiProviderConfiguration,
): boolean {
  if (!("baseUrl" in configuration)) return false;
  return isPlaintextProviderBaseUrl(configuration.baseUrl);
}

function copyPublicConfiguration(
  configuration: AiProviderConfiguration,
): AiProviderConfiguration {
  const common = {
    contextLengthOverride: configuration.contextLengthOverride,
    ...(configuration.reasoningModelCompatibility
      ? { reasoningModelCompatibility: true }
      : {}),
    credentialSet: configuration.credentialSet,
    credentialUpdatedAt: configuration.credentialUpdatedAt,
  };
  switch (configuration.provider) {
    case "openai-compatible":
      return {
        provider: configuration.provider,
        baseUrl: configuration.baseUrl,
        ...(configuration.apiVersion === undefined
          ? {}
          : { apiVersion: configuration.apiVersion }),
        models: [...(configuration.models ?? [])],
        ...common,
      };
    case "gemini":
      return {
        provider: configuration.provider,
        models: [...(configuration.models ?? [])],
        ...common,
      };
    case "claude":
      return {
        provider: configuration.provider,
        models: [...(configuration.models ?? [])],
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
        contextLengthOverrides: configuration.contextLengthOverrides.map(
          (entry) => ({ ...entry }),
        ),
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
    reasoningModelCompatibility:
      connection.config.reasoningModelCompatibility === true,
    credential: "",
  };
  switch (connection.config.provider) {
    case "openai-compatible":
      return {
        provider: connection.config.provider,
        baseUrl: connection.config.baseUrl,
        requestStyle: "v1",
        apiVersion: connection.config.apiVersion ?? "",
        deployments: "",
        models: (connection.config.models ?? []).join("\n"),
        ...common,
      };
    case "gemini":
      return {
        provider: connection.config.provider,
        baseUrl: "",
        requestStyle: "v1",
        apiVersion: "",
        deployments: "",
        models: (connection.config.models ?? []).join("\n"),
        ...common,
      };
    case "claude":
      return {
        provider: connection.config.provider,
        baseUrl: "",
        requestStyle: "v1",
        apiVersion: "",
        deployments: "",
        models: (connection.config.models ?? []).join("\n"),
        ...common,
      };
    case "azure": {
      const configuration = connection.config;
      return {
        provider: configuration.provider,
        baseUrl: configuration.baseUrl,
        requestStyle: configuration.requestStyle,
        apiVersion: configuration.apiVersion ?? "",
        deployments: configuration.deployments
          .map((deployment) => {
            const contextLength =
              configuration.contextLengthOverrides.find(
                (entry) => entry.model === deployment,
              )?.contextLength ?? configuration.contextLengthOverride;
            return contextLength == null
              ? deployment
              : `${deployment} = ${contextLength}`;
          })
          .join("\n"),
        models: "",
        ...common,
        contextLengthOverride: "",
      };
    }
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
    case "models":
      return t("ai_reviewer_provider_fallback_models");
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

function azureDeploymentEntries(value: string) {
  const entries = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const separator = line.indexOf("=");
      const model = (separator < 0 ? line : line.slice(0, separator)).trim();
      const contextText = separator < 0 ? "" : line.slice(separator + 1).trim();
      const contextLength = contextText === "" ? null : Number(contextText);
      return {
        model,
        contextLength,
        valid:
          (separator < 0 || !line.slice(separator + 1).includes("=")) &&
          (contextLength == null ||
            (Number.isSafeInteger(contextLength) && contextLength > 0)),
      };
    });
  return {
    deployments: entries.map((entry) => entry.model),
    contextLengthOverrides: entries.flatMap((entry) =>
      entry.contextLength == null
        ? []
        : [{ model: entry.model, contextLength: entry.contextLength }],
    ),
    valid: entries.every((entry) => entry.valid),
  };
}

function validFallbackModelName(model: string) {
  const [name, tag, ...extra] = model.split(":");
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/u.test(
      model,
    ) &&
    name.length <= 255 &&
    (tag === undefined || tag.length <= 128) &&
    extra.length === 0
  );
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
          ...(draft.apiVersion === "" ? {} : { apiVersion: draft.apiVersion }),
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
    case "AI_PROVIDER_CIRCUIT_OPEN":
      return t("ai_reviewer_error_guidance_circuit_open");
    case "AI_PROVIDER_COOLDOWN":
      return t("ai_reviewer_error_guidance_cooldown");
    case "AI_PROVIDER_MODEL_DISCOVERY_UNSUPPORTED":
      return t("ai_reviewer_provider_models_unavailable");
    case "AI_PROVIDER_NETWORK_FAILED":
      return t("ai_reviewer_provider_network_failed");
    case "AI_PROVIDER_NOT_CONFIGURED":
      return t("ai_reviewer_provider_not_configured");
    case "AI_PROVIDER_PLAINTEXT_CREDENTIAL_BLOCKED":
      return t("ai_reviewer_provider_plaintext_credential_blocked");
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
  scopeKey,
  onHide,
  listConnections,
  createConnection,
  updateConnection,
  deleteConnection,
  testConnection,
  connectionTestEnabled = true,
  listSkills,
  uploadSkill,
  previewSkillGitImport,
  confirmSkillGitImport: confirmSkillGitImportRequest,
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
  const [selectedSkillFileNames, setSelectedSkillFileNames] = useState<
    string[]
  >([]);
  const [pendingSkillDeletion, setPendingSkillDeletion] =
    useState<AiReviewerSkill | null>(null);
  const [skillGitSource, setSkillGitSource] = useState({
    ...emptySkillGitSource,
  });
  const [skillGitPreview, setSkillGitPreview] =
    useState<AiReviewerSkillGitPreview | null>(null);
  const [selectedSkillGitPaths, setSelectedSkillGitPaths] = useState<string[]>(
    [],
  );
  const skillOperationRef = useRef<AbortController | null>(null);
  const operationRef = useRef<{
    generation: number;
    controller: AbortController | null;
  }>({ generation: 0, controller: null });
  const connectionsChangedRef = useRef(false);

  const cancel = useCallback(() => {
    operationRef.current.controller?.abort();
    operationRef.current.controller = null;
    operationRef.current.generation += 1;
  }, []);

  const cancelPotentialWrite = () => {
    if (busy === "save" || busy === "connections") {
      connectionsChangedRef.current = true;
    }
    cancel();
  };

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
    connectionsChangedRef.current = false;
    setConnections(undefined);
    setSelectedId(null);
    setFormMode("idle");
    setDraft({ ...emptyConfiguration });
    setPendingNavigation(null);
    setPendingDeletion(null);
    setPendingSkillDeletion(null);
    setBusy(null);
    setNotice(null);

    void listConnections(scopeKey, operation.controller.signal).then(
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
  }, [applyConnections, begin, cancel, complete, listConnections, scopeKey]);

  useEffect(() => {
    skillOperationRef.current?.abort();
    const controller = new AbortController();
    skillOperationRef.current = controller;
    setSkills(undefined);
    setSkillBusy(false);
    setSkillNotice(null);
    setSelectedSkillFileNames([]);
    setSkillGitSource({ ...emptySkillGitSource });
    setSkillGitPreview(null);
    void listSkills(scopeKey, controller.signal).then(
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
  }, [listSkills, scopeKey]);

  const selected =
    connections?.find((entry) => entry.id === selectedId) ?? null;
  const saved =
    connections === undefined ? undefined : (selected?.config ?? null);
  const parsedAzureDeployments = azureDeploymentEntries(draft.deployments);
  const parsedDeployments = parsedAzureDeployments.deployments;
  const parsedModels = deploymentNames(draft.models);
  const editedDraftDirty =
    saved?.provider !== draft.provider ||
    (selected?.label ?? "") !== draft.label ||
    (saved?.contextLengthOverride == null
      ? ""
      : String(saved.contextLengthOverride)) !== draft.contextLengthOverride ||
    (saved?.reasoningModelCompatibility === true) !==
      draft.reasoningModelCompatibility ||
    (draft.provider === "openai-compatible" &&
      (saved?.provider !== "openai-compatible" ||
        saved.baseUrl !== draft.baseUrl ||
        (saved.apiVersion ?? "") !== draft.apiVersion ||
        (saved.models ?? []).join("\n") !== parsedModels.join("\n"))) ||
    (draft.provider === "gemini" &&
      (saved?.provider !== "gemini" ||
        (saved.models ?? []).join("\n") !== parsedModels.join("\n"))) ||
    (draft.provider === "claude" &&
      (saved?.provider !== "claude" ||
        (saved.models ?? []).join("\n") !== parsedModels.join("\n"))) ||
    (draft.provider === "azure" &&
      (saved?.provider !== "azure" ||
        saved.baseUrl !== draft.baseUrl ||
        saved.requestStyle !== draft.requestStyle ||
        (draft.requestStyle === "deployment" &&
          (saved.apiVersion ?? "") !== draft.apiVersion) ||
        draftFromConnection(selected as AiProviderConnection).deployments !==
          draft.deployments)) ||
    draft.credential !== "";
  const newDraftDirty =
    draft.provider !== emptyConfiguration.provider ||
    fields.some((field) => draft[field] !== "") ||
    draft.contextLengthOverride !== "" ||
    draft.reasoningModelCompatibility;
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
  const validAzureDeployments =
    parsedAzureDeployments.valid && validDeploymentNames(parsedDeployments);
  const validFallbackModels =
    parsedModels.length <= 100 &&
    new Set(parsedModels).size === parsedModels.length &&
    parsedModels.every(validFallbackModelName);
  const openAiBaseUrlHasCompletionPath =
    draft.provider === "openai-compatible" &&
    /\/chat\/completions\/?$/u.test(draft.baseUrl.trim());
  const providerBaseUrlIsPlaintext = isPlaintextProviderBaseUrl(draft.baseUrl);
  const keepingSavedBaseUrlCredential =
    draft.credential === "" &&
    saved != null &&
    "baseUrl" in saved &&
    saved.provider === draft.provider &&
    saved.baseUrl === draft.baseUrl &&
    saved.credentialSet;
  const plaintextCredentialBlocked =
    providerBaseUrlIsPlaintext &&
    (draft.credential.trim() !== "" || keepingSavedBaseUrlCredential);
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
    (draft.provider !== "openai-compatible" ||
      draft.apiVersion === "" ||
      openAiCompatibleApiVersion.test(draft.apiVersion)) &&
    (draft.provider === "azure" || validFallbackModels) &&
    !openAiBaseUrlHasCompletionPath &&
    !plaintextCredentialBlocked &&
    validContextLengthOverride &&
    credentialAvailable;
  const formEditable = formMode === "create" || formMode === "edit";
  const canSave =
    saved !== undefined && formEditable && busy === null && dirty && valid;
  const connectionLimitReached = (connections?.length ?? 0) >= connectionLimit;
  const updateDraft = (field: ConfigurationField, value: string) => {
    if (!formEditable) return;
    if (busy) cancelPotentialWrite();
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

  const updateReasoningModelCompatibility = (value: boolean) => {
    if (!formEditable) return;
    if (busy) cancelPotentialWrite();
    setDraft((current) => ({
      ...current,
      reasoningModelCompatibility: value,
    }));
    setBusy(null);
    setNotice(null);
  };

  const updateAzureRequestStyle = (value: string) => {
    if (!formEditable || (value !== "v1" && value !== "deployment")) {
      return;
    }
    if (busy) cancelPotentialWrite();
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
    if (busy) cancelPotentialWrite();
    // Destination-specific fields must not survive a provider change. Keeping
    // baseUrl empty also makes plaintext policy structural rather than vendor-based.
    setDraft((current) => ({
      ...current,
      provider,
      baseUrl: "",
      apiVersion: "",
      credential: "",
      contextLengthOverride: "",
      reasoningModelCompatibility: false,
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
    const reasoningModelCompatibility = draft.reasoningModelCompatibility
      ? { reasoningModelCompatibility: true }
      : {};
    const label = draft.label.trim();
    let requested: AiProviderConfigurationWrite;
    switch (draft.provider) {
      case "openai-compatible":
        requested = {
          provider: draft.provider,
          baseUrl: draft.baseUrl,
          ...(draft.apiVersion === "" ? {} : { apiVersion: draft.apiVersion }),
          models: parsedModels,
          label,
          contextLengthOverride: parsedContextLengthOverride,
          ...reasoningModelCompatibility,
          ...credential,
        };
        break;
      case "gemini":
        requested = {
          provider: draft.provider,
          models: parsedModels,
          label,
          contextLengthOverride: parsedContextLengthOverride,
          ...reasoningModelCompatibility,
          ...credential,
        };
        break;
      case "claude":
        requested = {
          provider: draft.provider,
          models: parsedModels,
          label,
          contextLengthOverride: parsedContextLengthOverride,
          ...reasoningModelCompatibility,
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
          contextLengthOverrides: parsedAzureDeployments.contextLengthOverrides,
          label,
          contextLengthOverride: null,
          ...reasoningModelCompatibility,
          ...credential,
        };
        break;
    }
    const editedId = selectedId;
    const editedRevision = selected?.revision;
    if (editedId != null && editedRevision == null) return;
    connectionsChangedRef.current = true;
    void run("save", (signal) =>
      editedId == null
        ? createConnection(scopeKey, requested, signal)
        : updateConnection(
            scopeKey,
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
    connectionTestEnabled &&
    !formEditable &&
    busy === null &&
    (connection.config.provider === "openai-compatible" ||
      connection.config.credentialSet);

  const handleTest = (connection: AiProviderConnection) => {
    if (!canTestConnection(connection)) return;
    void run("test", (signal) =>
      testConnection(scopeKey, connection.id, signal),
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
      cancelPotentialWrite();
      skillOperationRef.current?.abort();
      skillOperationRef.current = null;
      onHide(connectionsChangedRef.current);
      return;
    }
    if (navigation.kind === "cancel") {
      if (busy) cancelPotentialWrite();
      setSelectedId(null);
      setFormMode("idle");
      setDraft({ ...emptyConfiguration });
      setBusy(null);
      setNotice(null);
      return;
    }
    if (navigation.kind === "add") {
      if (connectionLimitReached) return;
      if (busy) cancelPotentialWrite();
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
    if (busy) cancelPotentialWrite();
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
    connectionsChangedRef.current = true;
    void run("connections", (signal) =>
      deleteConnection(scopeKey, connection.id, connection.revision, signal),
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
    setSelectedSkillFileNames(selectedFiles.map((file) => file.name));

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
      uploadSkill(scopeKey, upload, signal),
    );
    if (created) {
      setSkills((current) => [...(current ?? []), created]);
    }
  };

  const handleSkillDelete = (skill: AiReviewerSkill) => {
    if (skillBusy) return;
    setPendingSkillDeletion(skill);
  };

  const updateSkillGitSource = <Field extends keyof AiReviewerSkillGitSource>(
    field: Field,
    value: AiReviewerSkillGitSource[Field],
  ) => {
    setSkillGitSource((current) => ({
      ...current,
      [field]: value,
      ...(field === "repository" ? { gitHostType: "auto" as const } : {}),
    }));
    setSkillGitPreview(null);
    setSelectedSkillGitPaths([]);
    setSkillNotice(null);
  };

  const handleSkillGitPreview = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (skillBusy || skills === undefined) return;
    const preview = await runSkillRequest((signal) =>
      previewSkillGitImport(scopeKey, skillGitSource, signal),
    );
    if (preview) {
      setSkillGitPreview(preview);
      const remaining = Math.max(0, skillCountLimit - (skills?.length ?? 0));
      setSelectedSkillGitPaths(
        preview.skills.length <= remaining
          ? preview.skills.map((skill) => skill.path)
          : [],
      );
    }
  };

  const setAllGitSkillsSelected = (selected: boolean) => {
    setSelectedSkillGitPaths(
      selected && skillGitPreview != null
        ? skillGitPreview.skills.map((skill) => skill.path)
        : [],
    );
  };

  const setGitSkillSelected = (path: string, selected: boolean) => {
    setSelectedSkillGitPaths((current) =>
      selected
        ? current.includes(path)
          ? current
          : [...current, path]
        : current.filter((selectedPath) => selectedPath !== path),
    );
  };

  const confirmSkillGitImport = async () => {
    const preview = skillGitPreview;
    if (
      preview == null ||
      skillBusy ||
      selectedSkillGitPaths.length === 0 ||
      (skills?.length ?? 0) + selectedSkillGitPaths.length > skillCountLimit
    ) {
      return;
    }
    const created = await runSkillRequest((signal) =>
      confirmSkillGitImportRequest(
        scopeKey,
        {
          ...skillGitSource,
          resolvedSha: preview.source.resolvedSha,
          contentHash: preview.contentHash,
          selectedPaths: selectedSkillGitPaths,
        },
        signal,
      ),
    );
    if (created) {
      setSkills((current) => [...(current ?? []), ...created.skills]);
      setSkillGitPreview(null);
      setSelectedSkillGitPaths([]);
    }
  };

  const confirmSkillDelete = () => {
    const skill = pendingSkillDeletion;
    if (skill == null || skillBusy) return;
    setPendingSkillDeletion(null);
    void runSkillRequest((signal) =>
      deleteSkill(scopeKey, skill.id, signal),
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
  const skillUploadDisabled = skills === undefined || skillBusy;
  const skillGitPreviewDisabled =
    skills === undefined ||
    skillBusy ||
    skillGitSource.repository.length === 0 ||
    (repositoryNeedsHostType(skillGitSource.repository) &&
      skillGitSource.gitHostType === "auto");
  const selectedGitSkillCountExceedsLimit =
    (skills?.length ?? 0) + selectedSkillGitPaths.length > skillCountLimit;
  const skillGitConfirmDisabled =
    skillBusy ||
    selectedSkillGitPaths.length === 0 ||
    selectedGitSkillCountExceedsLimit;
  const skillGroups = storedSkillGroups(skills ?? []);
  const connectionTestDisabledReason = connectionTestEnabled
    ? null
    : t("ai_reviewer_connection_test_project_only");

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
        <TabContainer
          id="ai-reviewer-settings-tabs"
          defaultActiveKey="connections"
          mountOnEnter
          transition={false}
        >
          <div className="ol-tabs">
            <div className="nav-tabs-container">
              <Nav
                as="ul"
                variant="tabs"
                className="ai-reviewer-settings-tabs"
                aria-label={t("ai_reviewer_title")}
              >
                <Nav.Item as="li">
                  <Nav.Link eventKey="connections">
                    {t("ai_reviewer_connections")}
                  </Nav.Link>
                </Nav.Item>
                <Nav.Item as="li">
                  <Nav.Link eventKey="skills">
                    {t("ai_reviewer_skills")}
                  </Nav.Link>
                </Nav.Item>
              </Nav>
            </div>
            <TabContent className="ai-reviewer-settings-tab-content">
              <TabPane
                eventKey="connections"
                className="ai-reviewer-settings-tab-pane"
              >
                <section
                  className="ai-reviewer-connections"
                  aria-labelledby="ai-reviewer-connections-heading"
                >
                  <h3 id="ai-reviewer-connections-heading" className="h5">
                    {t("ai_reviewer_connections")}
                  </h3>
                  {connectionTestDisabledReason != null && (
                    <p className="ai-reviewer-provider-settings-hint">
                      {connectionTestDisabledReason}
                    </p>
                  )}
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
                            <th scope="col">
                              {t("ai_reviewer_provider_credential")}
                            </th>
                            <th scope="col">
                              <span className="visually-hidden">
                                {t("actions")}
                              </span>
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
                                  {providerTableLabel(
                                    connection.config.provider,
                                    t,
                                  )}
                                </span>
                                {isPlaintextProviderConfiguration(
                                  connection.config,
                                ) && (
                                  <span className="ai-reviewer-connection-plaintext">
                                    {t(
                                      "ai_reviewer_provider_plaintext_endpoint",
                                    )}
                                  </span>
                                )}
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
                                    : t(
                                        "ai_reviewer_provider_credential_not_set",
                                      )}
                                </OLBadge>
                                {connection.config.credentialUpdatedAt && (
                                  <time
                                    dateTime={
                                      connection.config.credentialUpdatedAt
                                    }
                                    title={
                                      connection.config.credentialUpdatedAt
                                    }
                                  >
                                    {t("ai_reviewer_last_updated", {
                                      updatedAt: formatTimeBasedOnYear(
                                        connection.config.credentialUpdatedAt,
                                      ),
                                    })}
                                  </time>
                                )}
                                {isPlaintextProviderConfiguration(
                                  connection.config,
                                ) &&
                                  connection.config.credentialSet && (
                                    <span className="ai-reviewer-connection-plaintext-credential">
                                      {t(
                                        "ai_reviewer_provider_plaintext_credential_blocked",
                                      )}
                                    </span>
                                  )}
                              </td>
                              <td className="ai-reviewer-connection-actions-cell">
                                <OLButtonGroup aria-label={t("actions")}>
                                  <OLIconButton
                                    type="button"
                                    size="sm"
                                    variant="secondary"
                                    icon="network_check"
                                    accessibilityLabel={`${t(
                                      "ai_reviewer_connection_test_named",
                                      { connection: connection.label },
                                    )}${
                                      connectionTestDisabledReason == null
                                        ? ""
                                        : `. ${connectionTestDisabledReason}`
                                    }`}
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
                          onChange={(event) =>
                            updateProvider(event.target.value)
                          }
                          disabled={
                            saved === undefined || formMode !== "create"
                          }
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
                              {t(
                                "ai_reviewer_provider_azure_request_style_deployment",
                              )}
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
                              draft.provider === "openai-compatible" ||
                              (draft.provider === "azure" &&
                                draft.requestStyle === "deployment")) &&
                            (field !== "deployments" ||
                              draft.provider === "azure") &&
                            (field !== "models" || draft.provider !== "azure"),
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
                                : field === "apiVersion" &&
                                    draft.provider === "openai-compatible"
                                  ? t("ai_reviewer_provider_api_version")
                                  : fieldLabel(field, t)}
                              {field === "apiVersion" && (
                                <>
                                  {" "}
                                  <span className="fw-normal">
                                    ({t("optional")})
                                  </span>
                                </>
                              )}
                            </OLFormLabel>
                            <OLFormControl
                              as={
                                field === "deployments" || field === "models"
                                  ? "textarea"
                                  : undefined
                              }
                              type={
                                field === "credential" ? "password" : "text"
                              }
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
                                field === "deployments"
                                  ? "ai-reviewer-azure-deployments-help"
                                  : field === "models"
                                    ? "ai-reviewer-fallback-models-help"
                                    : field === "apiVersion"
                                      ? "ai-reviewer-apiVersion-help"
                                      : field === "credential" &&
                                          plaintextCredentialBlocked
                                        ? "ai-reviewer-plaintext-credential-warning"
                                        : field === "baseUrl" &&
                                            draft.provider ===
                                              "openai-compatible"
                                          ? `ai-reviewer-baseUrl-help${
                                              providerBaseUrlIsPlaintext
                                                ? " ai-reviewer-baseUrl-plaintext-warning"
                                                : ""
                                            }${
                                              openAiBaseUrlHasCompletionPath
                                                ? " ai-reviewer-baseUrl-error"
                                                : ""
                                            }`
                                          : field === "baseUrl" &&
                                              draft.provider === "azure"
                                            ? "ai-reviewer-azure-endpoint-help"
                                            : undefined
                              }
                              aria-invalid={
                                field === "baseUrl" &&
                                openAiBaseUrlHasCompletionPath
                                  ? true
                                  : undefined
                              }
                              required={
                                field === "credential" && credentialRequired
                              }
                              aria-required={
                                field === "credential"
                                  ? credentialRequired
                                  : undefined
                              }
                              className="ai-reviewer-provider-settings-control"
                            />
                            {field === "apiVersion" && (
                              <p
                                id="ai-reviewer-apiVersion-help"
                                className="ai-reviewer-provider-advanced-help mt-1 mb-0"
                              >
                                {t(
                                  draft.provider === "openai-compatible"
                                    ? "ai_reviewer_provider_api_version_help"
                                    : "ai_reviewer_provider_azure_api_version_help",
                                )}
                              </p>
                            )}
                            {field === "models" && (
                              <p
                                id="ai-reviewer-fallback-models-help"
                                className="ai-reviewer-provider-advanced-help mt-1 mb-0"
                              >
                                {t("ai_reviewer_provider_fallback_models_help")}
                              </p>
                            )}
                            {field === "deployments" && (
                              <p
                                id="ai-reviewer-azure-deployments-help"
                                className="ai-reviewer-provider-advanced-help mt-1 mb-0"
                              >
                                {t(
                                  "ai_reviewer_provider_azure_deployments_help",
                                )}
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
                                  {providerBaseUrlIsPlaintext && (
                                    <p
                                      id="ai-reviewer-baseUrl-plaintext-warning"
                                      className="ai-reviewer-provider-plaintext-warning mt-1 mb-0"
                                      role="status"
                                    >
                                      {t(
                                        "ai_reviewer_provider_plaintext_endpoint",
                                      )}
                                    </p>
                                  )}
                                </>
                              )}
                            {field === "credential" &&
                              plaintextCredentialBlocked && (
                                <p
                                  id="ai-reviewer-plaintext-credential-warning"
                                  className="ai-reviewer-provider-plaintext-credential-warning mt-1 mb-0"
                                  role="alert"
                                >
                                  {t(
                                    "ai_reviewer_provider_plaintext_credential_blocked",
                                  )}
                                </p>
                              )}
                            {field === "baseUrl" &&
                              draft.provider === "azure" && (
                                <p
                                  id="ai-reviewer-azure-endpoint-help"
                                  className="ai-reviewer-provider-advanced-help mt-1 mb-0"
                                >
                                  {t(
                                    "ai_reviewer_provider_azure_endpoint_help",
                                  )}
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
                              {t(
                                "ai_reviewer_provider_request_url_unavailable",
                              )}
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
                          {draft.provider !== "azure" && (
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
                                  updateDraft(
                                    "contextLengthOverride",
                                    event.target.value,
                                  )
                                }
                                disabled={saved === undefined || !formEditable}
                                autoComplete="off"
                                aria-describedby={
                                  draft.provider === "openai-compatible"
                                    ? "ai-reviewer-contextLengthOverride-help ai-reviewer-ollama-context-length-help"
                                    : "ai-reviewer-contextLengthOverride-help"
                                }
                                className="ai-reviewer-provider-settings-control"
                              />
                              <p
                                id="ai-reviewer-contextLengthOverride-help"
                                className="ai-reviewer-provider-advanced-help mt-1 mb-0"
                              >
                                {t(
                                  "ai_reviewer_provider_context_length_override_help",
                                )}
                              </p>
                              {draft.provider === "openai-compatible" && (
                                <p
                                  id="ai-reviewer-ollama-context-length-help"
                                  className="ai-reviewer-provider-advanced-help mt-1 mb-0"
                                >
                                  {t(
                                    "ai_reviewer_provider_ollama_context_length_help",
                                  )}
                                </p>
                              )}
                            </OLFormGroup>
                          )}
                          <OLFormCheckbox
                            id="ai-reviewer-reasoning-model-compatibility"
                            checked={draft.reasoningModelCompatibility}
                            disabled={saved === undefined || !formEditable}
                            label={t(
                              "ai_reviewer_provider_reasoning_model_compatibility",
                            )}
                            aria-describedby="ai-reviewer-reasoning-model-compatibility-help"
                            onChange={(event) =>
                              updateReasoningModelCompatibility(
                                event.currentTarget.checked,
                              )
                            }
                          />
                          <p
                            id="ai-reviewer-reasoning-model-compatibility-help"
                            className="ai-reviewer-provider-advanced-help mt-1 mb-0"
                          >
                            {t(
                              "ai_reviewer_provider_reasoning_model_compatibility_help",
                            )}
                          </p>
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
                            onClick={() =>
                              requestNavigation({ kind: "cancel" })
                            }
                          >
                            {t("cancel")}
                          </OLButton>
                          <OLButton
                            type="submit"
                            variant="primary"
                            disabled={!canSave}
                          >
                            {t("ai_reviewer_provider_save")}
                          </OLButton>
                        </OLButtonGroup>
                      </div>
                    </OLForm>
                  </OLCard>
                )}
              </TabPane>

              <TabPane
                eventKey="skills"
                className="ai-reviewer-settings-tab-pane"
              >
                <section
                  className="ai-reviewer-skills"
                  aria-labelledby="ai-reviewer-skills-heading"
                >
                  <h3 id="ai-reviewer-skills-heading" className="h5">
                    {t("ai_reviewer_skills")}
                  </h3>
                  <p className="ai-reviewer-skills-description">
                    {t("ai_reviewer_skills_description")}
                  </p>
                  <p className="ai-reviewer-skills-mode-help">
                    {t("ai_reviewer_skills_modes")}
                  </p>
                  {skills != null && skills.length === 0 && (
                    <p className="ai-reviewer-skills-empty">
                      {t("ai_reviewer_skills_empty")}
                    </p>
                  )}
                  {skills != null && skills.length > 0 && (
                    <ul
                      className="ai-reviewer-skill-group-list"
                      aria-label={t("ai_reviewer_skills")}
                    >
                      {skillGroups.map((group) => (
                        <li
                          key={group.key}
                          className="ai-reviewer-skill-group-item"
                        >
                          <details
                            className="ai-reviewer-skill-group"
                            data-testid="ai-reviewer-skill-group"
                          >
                            <summary className="ai-reviewer-skill-group-summary">
                              <span className="ai-reviewer-skill-group-header">
                                <span className="ai-reviewer-skill-group-identity">
                                  <strong>{group.name}</strong>
                                  <span className="ai-reviewer-skill-group-source">
                                    {group.kind === "local"
                                      ? "Uploaded from local files"
                                      : `${group.provenance.host} · ${group.provenance.repository}`}
                                  </span>
                                </span>
                                <span className="ai-reviewer-skill-group-metadata">
                                  {group.kind === "git" && (
                                    <>
                                      <span>
                                        {t(
                                          "ai_reviewer_skill_git_preview_owner",
                                        )}
                                        :{" "}
                                        {storedSkillGroupMetadata(
                                          group.ownerNames,
                                          t("ai_reviewer_skill_git_unknown"),
                                        )}
                                      </span>
                                      <span>
                                        {t(
                                          "ai_reviewer_skill_git_preview_version",
                                        )}
                                        :{" "}
                                        {storedSkillGroupMetadata(
                                          group.pluginVersions,
                                          t("ai_reviewer_skill_git_unknown"),
                                        )}
                                      </span>
                                      <span>
                                        {t(
                                          "ai_reviewer_skill_git_preview_license",
                                        )}
                                        :{" "}
                                        {storedSkillGroupMetadata(
                                          group.licenses,
                                          t("ai_reviewer_skill_git_unknown"),
                                        )}
                                      </span>
                                    </>
                                  )}
                                  <span>
                                    {storedSkillCount(group.skills.length)}
                                  </span>
                                </span>
                              </span>
                            </summary>
                            <ul className="ai-reviewer-skill-list">
                              {group.skills.map((skill) => (
                                <li
                                  key={skill.id}
                                  className="ai-reviewer-skill-item"
                                >
                                  <details
                                    className="ai-reviewer-skill-row"
                                    data-testid="ai-reviewer-skill-row"
                                  >
                                    <summary className="ai-reviewer-skill-summary">
                                      <strong>{skill.name}</strong>
                                    </summary>
                                    <div className="ai-reviewer-skill-detail">
                                      <p className="mb-0">
                                        {skill.description}
                                      </p>
                                      <p className="ai-reviewer-skill-metadata mb-0">
                                        {t("ai_reviewer_skill_stored_bytes", {
                                          count: skill.sizeBytes,
                                          size: String(skill.sizeBytes),
                                        })}
                                      </p>
                                      <p className="ai-reviewer-skill-metadata mb-0">
                                        {t(
                                          "ai_reviewer_skill_git_preview_references",
                                        )}
                                        : {skill.referenceCount}
                                      </p>
                                      <OLButton
                                        type="button"
                                        variant="danger"
                                        className="ai-reviewer-skill-delete"
                                        disabled={skillBusy}
                                        aria-label={`${t("delete")} ${skill.name}`}
                                        onClick={() => handleSkillDelete(skill)}
                                      >
                                        {t("delete")}
                                      </OLButton>
                                    </div>
                                  </details>
                                </li>
                              ))}
                            </ul>
                          </details>
                        </li>
                      ))}
                    </ul>
                  )}
                  <section
                    className="ai-reviewer-skill-git-import"
                    aria-labelledby="ai-reviewer-skill-git-import-heading"
                  >
                    <h4
                      id="ai-reviewer-skill-git-import-heading"
                      className="h6"
                    >
                      {t("ai_reviewer_skill_git_import_title")}
                    </h4>
                    <p className="ai-reviewer-skill-git-import-help">
                      {t("ai_reviewer_skill_git_import_help")}
                    </p>
                    <OLForm onSubmit={handleSkillGitPreview}>
                      <OLFormGroup controlId="ai-reviewer-skill-git-repository">
                        <OLFormLabel>
                          {t("ai_reviewer_skill_git_repository")}
                        </OLFormLabel>
                        <OLFormControl
                          type="text"
                          value={skillGitSource.repository}
                          disabled={skillBusy}
                          placeholder={t(
                            "ai_reviewer_skill_git_repository_placeholder",
                          )}
                          onChange={(event: ChangeEvent<HTMLInputElement>) =>
                            updateSkillGitSource(
                              "repository",
                              event.currentTarget.value,
                            )
                          }
                        />
                        <OLFormText>
                          {t("ai_reviewer_skill_git_repository_help")}
                        </OLFormText>
                      </OLFormGroup>
                      <div className="ai-reviewer-skill-git-fields">
                        {repositoryNeedsHostType(skillGitSource.repository) && (
                          <OLFormGroup controlId="ai-reviewer-skill-git-host-type">
                            <OLFormLabel>
                              {t("ai_reviewer_skill_git_host_type")}
                            </OLFormLabel>
                            <OLFormSelect
                              value={skillGitSource.gitHostType}
                              disabled={skillBusy}
                              onChange={(event) =>
                                updateSkillGitSource(
                                  "gitHostType",
                                  event.currentTarget
                                    .value as AiReviewerSkillGitHostType,
                                )
                              }
                            >
                              <option value="auto">
                                {t("ai_reviewer_skill_git_host_auto")}
                              </option>
                              <option value="github">
                                {t("ai_reviewer_skill_git_host_github")}
                              </option>
                              <option value="gitlab">
                                {t("ai_reviewer_skill_git_host_gitlab")}
                              </option>
                            </OLFormSelect>
                          </OLFormGroup>
                        )}
                        <OLFormGroup controlId="ai-reviewer-skill-git-ref">
                          <OLFormLabel>
                            {t("ai_reviewer_skill_git_ref")}
                          </OLFormLabel>
                          <OLFormControl
                            type="text"
                            value={skillGitSource.ref}
                            disabled={skillBusy}
                            placeholder={t(
                              "ai_reviewer_skill_git_ref_placeholder",
                            )}
                            onChange={(event: ChangeEvent<HTMLInputElement>) =>
                              updateSkillGitSource(
                                "ref",
                                event.currentTarget.value,
                              )
                            }
                          />
                          <OLFormText>
                            {t("ai_reviewer_skill_git_ref_help")}
                          </OLFormText>
                        </OLFormGroup>
                      </div>
                      <div className="ai-reviewer-skill-git-actions">
                        <OLButton
                          type="submit"
                          variant="secondary"
                          disabled={skillGitPreviewDisabled}
                        >
                          {t("ai_reviewer_skill_git_preview")}
                        </OLButton>
                      </div>
                    </OLForm>
                    {skillGitPreview && (
                      <div
                        className="ai-reviewer-skill-git-preview"
                        role="region"
                        aria-label={t("ai_reviewer_skill_git_preview_heading")}
                      >
                        <h5 className="h6">
                          {t("ai_reviewer_skill_git_preview_heading")}
                        </h5>
                        {skillGitPreview.truncated && (
                          <p role="status">
                            {t("ai_reviewer_skill_git_preview_truncated")}
                          </p>
                        )}
                        <p className="ai-reviewer-skill-git-source">
                          {t("ai_reviewer_skill_git_understood_host", {
                            service: t(
                              skillGitPreview.source.service === "github"
                                ? "ai_reviewer_skill_git_host_github"
                                : "ai_reviewer_skill_git_host_gitlab",
                            ),
                            host: skillGitPreview.source.host,
                          })}
                        </p>
                        <dl className="ai-reviewer-skill-git-preview-details">
                          <dt>{t("ai_reviewer_skill_git_preview_sha")}</dt>
                          <dd>
                            <code>{skillGitPreview.source.resolvedSha}</code>
                          </dd>
                        </dl>
                        {skillGitPreview.manifestFound ? (
                          <div className="ai-reviewer-skill-git-plugins">
                            {skillGitPreview.plugins.map((plugin) => (
                              <section key={plugin.name}>
                                <h6>{plugin.name}</h6>
                                <dl className="ai-reviewer-skill-git-preview-details">
                                  <dt>
                                    {t("ai_reviewer_skill_git_preview_version")}
                                  </dt>
                                  <dd>
                                    {plugin.version ??
                                      t("ai_reviewer_skill_git_unknown")}
                                  </dd>
                                  <dt>
                                    {t("ai_reviewer_skill_git_preview_license")}
                                  </dt>
                                  <dd>
                                    {plugin.license ??
                                      t("ai_reviewer_skill_git_unknown")}
                                  </dd>
                                  <dt>
                                    {t("ai_reviewer_skill_git_preview_owner")}
                                  </dt>
                                  <dd>
                                    {plugin.owner == null
                                      ? t("ai_reviewer_skill_git_unknown")
                                      : plugin.owner.url == null
                                        ? plugin.owner.name
                                        : `${plugin.owner.name} (${plugin.owner.url})`}
                                  </dd>
                                  <dt>
                                    {t(
                                      "ai_reviewer_skill_git_preview_homepage",
                                    )}
                                  </dt>
                                  <dd>
                                    {plugin.homepage ??
                                      t("ai_reviewer_skill_git_unknown")}
                                  </dd>
                                </dl>
                              </section>
                            ))}
                          </div>
                        ) : (
                          <p className="ai-reviewer-skill-git-no-manifest">
                            {t("ai_reviewer_skill_git_no_manifest")}
                          </p>
                        )}
                        {skillGitPreview.skippedPlugins.length > 0 && (
                          <section className="ai-reviewer-skill-git-skipped-plugins">
                            <h6>
                              {t("ai_reviewer_skill_git_skipped_plugins")}
                            </h6>
                            <ul>
                              {skillGitPreview.skippedPlugins.map(
                                (plugin, index) => (
                                  <li
                                    key={`${plugin.name}-${plugin.reason}-${plugin.skillPath ?? plugin.sourceUrl ?? index}`}
                                  >
                                    <strong>{plugin.name}</strong>
                                    {": "}
                                    {t(
                                      skippedPluginReasonTranslation(
                                        plugin.reason,
                                      ),
                                    )}
                                    {plugin.sourceUrl != null && (
                                      <>
                                        {" "}
                                        <code>{plugin.sourceUrl}</code>
                                      </>
                                    )}
                                    {plugin.sourcePath != null && (
                                      <>
                                        {" "}
                                        <code>{plugin.sourcePath}</code>
                                      </>
                                    )}
                                    {plugin.skillPath != null && (
                                      <>
                                        {" "}
                                        <code>{plugin.skillPath}</code>
                                      </>
                                    )}
                                  </li>
                                ),
                              )}
                            </ul>
                          </section>
                        )}
                        <div className="ai-reviewer-skill-git-selection">
                          <OLFormCheckbox
                            id="ai-reviewer-skill-git-select-all"
                            checked={
                              selectedSkillGitPaths.length ===
                              skillGitPreview.skills.length
                            }
                            disabled={skillBusy}
                            label={t("ai_reviewer_skill_git_select_all")}
                            onChange={(event) =>
                              setAllGitSkillsSelected(
                                event.currentTarget.checked,
                              )
                            }
                          />
                          {skillGitPreview.skills.map((skill) => (
                            <section
                              key={skill.path}
                              className="ai-reviewer-skill-git-preview-skill"
                            >
                              <OLFormCheckbox
                                id={`ai-reviewer-skill-git-${skill.path.replace(/[^A-Za-z0-9_-]/gu, "-")}`}
                                checked={selectedSkillGitPaths.includes(
                                  skill.path,
                                )}
                                disabled={skillBusy}
                                label={skill.name}
                                onChange={(event) =>
                                  setGitSkillSelected(
                                    skill.path,
                                    event.currentTarget.checked,
                                  )
                                }
                              />
                              <p>{skill.description}</p>
                              <dl className="ai-reviewer-skill-git-preview-details">
                                <dt>
                                  {t("ai_reviewer_skill_git_preview_path")}
                                </dt>
                                <dd>
                                  <code>{skill.path}</code>
                                </dd>
                                <dt>
                                  {t("ai_reviewer_skill_git_preview_body_size")}
                                </dt>
                                <dd>
                                  {t("ai_reviewer_skill_git_bytes", {
                                    count: skill.bodySizeBytes,
                                    size: String(skill.bodySizeBytes),
                                  })}
                                </dd>
                                <dt>
                                  {t(
                                    "ai_reviewer_skill_git_preview_references",
                                  )}
                                </dt>
                                <dd>
                                  {skill.referenceFiles.length === 0
                                    ? t("ai_reviewer_skill_git_no_references")
                                    : skill.referenceFiles.map((reference) => (
                                        <span
                                          className="d-block"
                                          key={reference.path}
                                        >
                                          <code>{reference.path}</code>{" "}
                                          {t("ai_reviewer_skill_git_bytes", {
                                            count: reference.sizeBytes,
                                            size: String(reference.sizeBytes),
                                          })}
                                        </span>
                                      ))}
                                </dd>
                                <dt>
                                  {t(
                                    "ai_reviewer_skill_git_preview_skipped_mentions",
                                  )}
                                </dt>
                                <dd>
                                  {skill.skippedReferences.length === 0
                                    ? t(
                                        "ai_reviewer_skill_git_no_skipped_mentions",
                                      )
                                    : skill.skippedReferences.map(
                                        (reference) => (
                                          <span
                                            className="d-block"
                                            key={reference.path}
                                          >
                                            <code>{reference.path}</code>{" "}
                                            {t(
                                              skippedReferenceReasonTranslation(
                                                reference.reason,
                                              ),
                                            )}
                                          </span>
                                        ),
                                      )}
                                </dd>
                              </dl>
                            </section>
                          ))}
                        </div>
                        {selectedGitSkillCountExceedsLimit && (
                          <p className="text-danger" role="alert">
                            {t("ai_reviewer_skill_git_count_limit", {
                              limit: String(skillCountLimit),
                            })}
                          </p>
                        )}
                        <OLButton
                          type="button"
                          variant="primary"
                          disabled={skillGitConfirmDisabled}
                          onClick={confirmSkillGitImport}
                        >
                          {t("ai_reviewer_skill_git_confirm")}
                        </OLButton>
                      </div>
                    )}
                  </section>
                  <OLFormGroup
                    controlId="ai-reviewer-skill-files"
                    className="ai-reviewer-skill-upload"
                  >
                    <div className="ai-reviewer-skill-upload-control">
                      <OLFormControl
                        type="file"
                        className="visually-hidden ai-reviewer-skill-file-input"
                        accept=".md,text/markdown"
                        multiple
                        disabled={skillUploadDisabled}
                        aria-describedby="ai-reviewer-skill-upload-help ai-reviewer-skill-upload-selection"
                        onChange={handleSkillUpload}
                      />
                      <OLFormLabel
                        className={`ai-reviewer-skill-file-label btn btn-secondary d-inline-grid${
                          skillUploadDisabled ? " disabled" : ""
                        }`}
                        aria-disabled={skillUploadDisabled}
                      >
                        <span className="button-content">
                          {t("ai_reviewer_skill_upload_label")}
                        </span>
                      </OLFormLabel>
                      <span
                        id="ai-reviewer-skill-upload-selection"
                        className="ai-reviewer-skill-upload-selection"
                        role="status"
                      >
                        {selectedSkillFileNames.length > 0 && (
                          <>
                            {`${selectedSkillFileNames.length} ${t(
                              "files_selected",
                            )}`}{" "}
                            {selectedSkillFileNames.join(", ")}
                          </>
                        )}
                      </span>
                    </div>
                    <OLFormText id="ai-reviewer-skill-upload-help">
                      {t("ai_reviewer_skill_upload_help")}
                    </OLFormText>
                  </OLFormGroup>
                  {skillNotice && (
                    <OLNotification type="error" content={skillNotice} />
                  )}
                </section>
              </TabPane>
            </TabContent>
          </div>
        </TabContainer>
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
      {pendingSkillDeletion != null && (
        <GenericConfirmModal
          show
          title={t("ai_reviewer_skill_delete_confirmation_title")}
          message={t("ai_reviewer_skill_delete_confirmation_message", {
            skill: pendingSkillDeletion.name,
          })}
          confirmLabel={t("delete")}
          primaryVariant="danger"
          onHide={() => setPendingSkillDeletion(null)}
          onConfirm={confirmSkillDelete}
        />
      )}
    </>
  );
}

export default function AiIntegrationDetails({
  onHide,
}: {
  onHide: (connectionsChanged: boolean) => void;
}) {
  const { projectId } = useProjectContext();
  return (
    <AiIntegrationDetailsView
      scopeKey={projectId}
      onHide={onHide}
      listConnections={getAiProviderConnections}
      createConnection={createAiProviderConnection}
      updateConnection={updateAiProviderConnection}
      deleteConnection={deleteAiProviderConnection}
      testConnection={testAiProviderConnection}
      listSkills={getAiReviewerSkills}
      uploadSkill={uploadAiReviewerSkill}
      previewSkillGitImport={previewAiReviewerSkillGitImport}
      confirmSkillGitImport={confirmAiReviewerSkillGitImport}
      deleteSkill={deleteAiReviewerSkill}
    />
  );
}

const accountSettingsScopeKey = "session-user";
const unavailableAccountConnectionTest = async () => {
  throw new Error("Connection tests require project context.");
};

export function AiReviewerAccountSettingsDetails({
  onHide,
}: {
  onHide: () => void;
}) {
  return (
    <AiIntegrationDetailsView
      scopeKey={accountSettingsScopeKey}
      onHide={() => onHide()}
      listConnections={getUserAiProviderConnections}
      createConnection={createUserAiProviderConnection}
      updateConnection={updateUserAiProviderConnection}
      deleteConnection={deleteUserAiProviderConnection}
      testConnection={unavailableAccountConnectionTest}
      connectionTestEnabled={false}
      listSkills={getUserAiReviewerSkills}
      uploadSkill={uploadUserAiReviewerSkill}
      previewSkillGitImport={previewUserAiReviewerSkillGitImport}
      confirmSkillGitImport={confirmUserAiReviewerSkillGitImport}
      deleteSkill={deleteUserAiReviewerSkill}
    />
  );
}
