import {
  OLModal,
  OLModalBody,
  OLModalHeader,
  OLModalTitle,
} from "@/shared/components/ol/ol-modal";

export default function AiIntegrationDetails({
  onHide,
}: {
  onHide: () => void;
}) {
  return (
    <OLModal show onHide={onHide}>
      <OLModalHeader closeButton>
        <OLModalTitle>AI reviewer</OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        <dl>
          <dt>Feature</dt>
          <dd>Enabled</dd>
          <dt>Provider</dt>
          <dd>Not configured</dd>
          <dt>Privacy boundary</dt>
          <dd>
            Browser requests remain inside the authenticated Overleaf backend.
          </dd>
        </dl>
      </OLModalBody>
    </OLModal>
  );
}
