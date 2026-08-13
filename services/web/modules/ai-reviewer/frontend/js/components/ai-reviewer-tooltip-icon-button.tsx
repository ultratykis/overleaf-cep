import MaterialIcon from "@/shared/components/material-icon";
import OLTooltip from "@/shared/components/ol/ol-tooltip";

export function AiReviewerTooltipIconButton({
  id,
  label,
  icon,
  className,
  buttonClassName = "btn",
  tooltipPlacement = "top",
  disabled = false,
  onClick,
}: {
  id: string;
  label: string;
  icon: string;
  className?: string;
  buttonClassName?: string;
  tooltipPlacement?: "top" | "right";
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <OLTooltip
      id={id}
      description={label}
      overlayProps={{
        placement: tooltipPlacement,
        trigger: ["hover", "focus"],
      }}
    >
      <span
        className={`ai-reviewer-tooltip-icon-button${
          className == null ? "" : ` ${className}`
        }`}
      >
        <button
          type="button"
          tabIndex={0}
          className={buttonClassName}
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          <MaterialIcon type={icon} />
        </button>
      </span>
    </OLTooltip>
  );
}
