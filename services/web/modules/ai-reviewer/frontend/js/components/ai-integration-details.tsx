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
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  AiProviderConfigurationClientError,
  type AiProviderConfiguration,
  type AiProviderConfigurationResponse,
  getAiProviderConfiguration,
  saveAiProviderConfiguration,
  testAiProviderConnection,
} from "../services/ai-provider-configuration";

type OperationKind = "save" | "test";
type Operation = { generation: number; controller: AbortController };
type Notice = { type: "success" | "error"; content: string };

type Props = {
  projectId: string;
  onHide: () => void;
  getConfiguration: typeof getAiProviderConfiguration;
  saveConfiguration: typeof saveAiProviderConfiguration;
  testConnection: typeof testAiProviderConnection;
};

const genericError = "Something went wrong. Check the settings and try again.";

const emptyConfiguration: AiProviderConfiguration = {
  provider: "ollama",
  baseUrl: "",
  model: "",
};

const fields = [
  ["baseUrl", "Base URL"],
  ["model", "Model"],
] as const;

function errorNotice(error: unknown): Notice {
  return {
    type: "error",
    content:
      error instanceof AiProviderConfigurationClientError
        ? error.message
        : genericError,
  };
}

export function AiIntegrationDetailsView({
  projectId,
  onHide,
  getConfiguration,
  saveConfiguration,
  testConnection,
}: Props) {
  const [saved, setSaved] = useState<
    AiProviderConfiguration | null | undefined
  >();
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
      const next = response.config ? { ...response.config } : null;
      setSaved(next);
      setDraft(next ? { ...next } : { ...emptyConfiguration });
      setBusy(null);
      setNotice(null);
    },
    [],
  );

  useEffect(() => {
    const operation = begin();
    setSaved(undefined);
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
    saved?.baseUrl !== draft.baseUrl || saved?.model !== draft.model;
  const valid = draft.baseUrl.trim() !== "" && draft.model.trim() !== "";
  const canSave = saved !== undefined && busy === null && dirty && valid;
  const canTest = saved != null && busy === null && !dirty;

  const updateDraft = (field: "baseUrl" | "model", value: string) => {
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
    const requested = { ...draft };
    void run("save", (signal) =>
      saveConfiguration(projectId, requested, signal),
    ).then((response) => {
      if (!response) return;
      if (response.config) {
        applyResponse(response);
      } else {
        setBusy(null);
        setNotice({ type: "error", content: genericError });
      }
    });
  };

  const handleTest = () => {
    if (!canTest) return;
    void run("test", (signal) => testConnection(projectId, signal)).then(
      (response) => {
        if (!response) return;
        setBusy(null);
        setNotice({ type: "success", content: "Connection successful" });
      },
    );
  };

  const handleHide = () => {
    cancel();
    onHide();
  };

  return (
    <OLModal show onHide={handleHide}>
      <OLModalHeader closeButton closeLabel="Close">
        <OLModalTitle>AI reviewer</OLModalTitle>
      </OLModalHeader>
      <OLForm onSubmit={handleSave}>
        <OLModalBody>
          <p className="mb-0">Provider: Ollama</p>
          {fields.map(([field, label]) => (
            <OLFormGroup
              key={field}
              controlId={`ai-reviewer-${field}`}
              className="mt-3"
            >
              <OLFormLabel>{label}</OLFormLabel>
              <OLFormControl
                value={draft[field]}
                onChange={(event) => updateDraft(field, event.target.value)}
                disabled={saved === undefined}
                autoComplete="off"
              />
            </OLFormGroup>
          ))}
          {saved && <p className="mt-3 mb-0">Local</p>}
          {notice && <OLNotification {...notice} />}
        </OLModalBody>
        <OLModalFooter>
          <OLButton
            type="button"
            variant="secondary"
            onClick={handleTest}
            disabled={!canTest}
          >
            Test connection
          </OLButton>
          <OLButton type="submit" variant="primary" disabled={!canSave}>
            Save
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
