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
  type ChangeEvent,
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
  type AiProviderConnection,
  type AiProviderConfigurationWrite,
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
  contextLengthOverride: string;
  credential: string;
};
type ConfigurationField =
  | "label"
  | "baseUrl"
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
  contextLengthOverride: "",
  credential: "",
};

const fields: ConfigurationField[] = ["label", "baseUrl", "credential"];

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
  }
}

function copyPublicConnection(
  connection: AiProviderConnection,
): AiProviderConnection {
  return {
    id: connection.id,
    label: connection.label,
    classification: connection.classification,
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
        ...common,
      };
    case "gemini":
      return {
        provider: connection.config.provider,
        baseUrl: "",
        ...common,
      };
    case "claude":
      return {
        provider: connection.config.provider,
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
    case "label":
      return t("ai_reviewer_provider_label");
    case "baseUrl":
      return t("ai_reviewer_provider_base_url");
    case "contextLengthOverride":
      return t("ai_reviewer_provider_context_length_override");
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
    case "AI_PROVIDER_CONFIGURATION_PERSISTENCE_FAILED":
      return t("ai_reviewer_provider_configuration_persistence_failed");
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
  // A null selection is the draft for a connection that does not exist yet,
  // which is also what a user with no connection at all starts from.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ ...emptyConfiguration });
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

  /**
   * Adopt a server listing wholesale. `nextId` names the connection the form
   * should edit afterwards; an unknown one falls back to the new-connection
   * draft, which is what deleting the edited connection has to do.
   */
  const applyConnections = useCallback(
    (list: AiProviderConnection[], nextId: string | null) => {
      const copied = list.map(copyPublicConnection);
      const selected = copied.find((entry) => entry.id === nextId) ?? null;
      setConnections(copied);
      setSelectedId(selected?.id ?? null);
      setDraft(
        selected ? draftFromConnection(selected) : { ...emptyConfiguration },
      );
      setBusy(null);
      setNotice(null);
    },
    [],
  );

  useEffect(() => {
    const operation = begin();
    setConnections(undefined);
    setSelectedId(null);
    setDraft({ ...emptyConfiguration });
    setBusy(null);
    setNotice(null);

    void listConnections(projectId, operation.controller.signal).then(
      (response) => {
        if (!complete(operation)) return;
        applyConnections(
          response.connections,
          response.connections[0]?.id ?? null,
        );
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
  const classification = selected?.classification ?? null;
  const dirty =
    saved?.provider !== draft.provider ||
    (selected?.label ?? "") !== draft.label ||
    (saved?.contextLengthOverride == null
      ? ""
      : String(saved.contextLengthOverride)) !== draft.contextLengthOverride ||
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
    validContextLengthOverride &&
    credentialAvailable;
  const canSave = saved !== undefined && busy === null && dirty && valid;
  const canTest =
    saved != null && busy === null && !dirty && credentialAvailable;
  const updateDraft = (field: ConfigurationField, value: string) => {
    if (busy) cancel();
    setDraft((current) => ({ ...current, [field]: value }));
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
    }
    const editedId = selectedId;
    void run("save", (signal) =>
      editedId == null
        ? createConnection(projectId, requested, signal)
        : updateConnection(projectId, editedId, requested, signal),
    ).then((connection) => {
      if (!connection) return;
      if (connection.config == null) {
        setBusy(null);
        setNotice(genericErrorNotice());
        return;
      }
      // A write returns only the written connection, so splice it into the
      // listing instead of paying for another round trip.
      applyConnections(
        editedId == null
          ? [...(connections ?? []), connection]
          : (connections ?? []).map((entry) =>
              entry.id === connection.id ? connection : entry,
            ),
        connection.id,
      );
    });
  };

  const handleTest = () => {
    if (!canTest) return;
    void run("test", (signal) =>
      testConnection(projectId, selectedId, signal),
    ).then((response) => {
      if (!response) return;
      setBusy(null);
      setNotice({
        type: "success",
        kind: "connectionSuccessful",
      });
    });
  };

  const handleAdd = () => {
    if (busy) cancel();
    setSelectedId(null);
    setDraft({ ...emptyConfiguration });
    setBusy(null);
    setNotice(null);
  };

  const handleSelect = (connection: AiProviderConnection) => {
    if (connection.id === selectedId) return;
    if (busy) cancel();
    setSelectedId(connection.id);
    setDraft(draftFromConnection(connection));
    setBusy(null);
    setNotice(null);
  };

  const handleDelete = (connection: AiProviderConnection) => {
    if (busy !== null) return;
    void run("connections", (signal) =>
      deleteConnection(projectId, connection.id, signal),
    ).then((response) => {
      if (!response) return;
      // Deleting the edited connection falls back to whichever connection is
      // left, so the form never points at something that no longer exists.
      const nextId =
        connection.id === selectedId
          ? (response.connections[0]?.id ?? null)
          : selectedId;
      applyConnections(response.connections, nextId);
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
    cancel();
    skillOperationRef.current?.abort();
    skillOperationRef.current = null;
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
          <section
            className="ai-reviewer-skills mb-3"
            aria-labelledby="ai-reviewer-skills-heading"
          >
            <h3 id="ai-reviewer-skills-heading" className="h5 mt-0">
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
            {skillNotice && (
              <OLNotification type="error" content={skillNotice} />
            )}
          </section>
          {connections != null && connections.length > 0 && (
            <div className="ai-reviewer-connections mb-3">
              <ul
                className="ai-reviewer-connection-list"
                aria-label={t("ai_reviewer_connections")}
              >
                {connections.map((connection) => (
                  <li
                    key={connection.id}
                    className="ai-reviewer-connection-row"
                    data-testid="ai-reviewer-connection-row"
                  >
                    <OLButton
                      type="button"
                      variant="link"
                      className="btn-inline-link ai-reviewer-connection-name"
                      aria-pressed={connection.id === selectedId}
                      onClick={() => handleSelect(connection)}
                    >
                      {connection.label}
                    </OLButton>
                    <OLButton
                      type="button"
                      variant="link"
                      className="btn-inline-link ai-reviewer-connection-action"
                      disabled={busy !== null}
                      onClick={() => handleDelete(connection)}
                    >
                      {t("ai_reviewer_connection_delete")}
                    </OLButton>
                  </li>
                ))}
              </ul>
              <OLButton
                type="button"
                variant="secondary"
                className="ai-reviewer-connection-add mt-2"
                disabled={busy !== null || selectedId == null}
                onClick={handleAdd}
              >
                {t("ai_reviewer_connection_add")}
              </OLButton>
            </div>
          )}
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
              {classification && (
                <p className="ai-reviewer-provider-endpoint mb-0">
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
          {busy === null && !canTest && (saved == null || dirty) && (
            <span
              className="ai-reviewer-provider-settings-hint"
              data-testid="ai-reviewer-unsaved-hint"
            >
              {t(
                "ai_reviewer_provider_save_before_checking",
                "Save your changes before checking the connection.",
              )}
            </span>
          )}
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
