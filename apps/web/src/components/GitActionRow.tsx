import type { ReactNode } from "react";
import { SlidersHorizontalIcon } from "lucide-react";

import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function GitActionRow({
  label,
  disabled,
  onRun,
  onConfigure,
  children,
}: {
  label: string;
  disabled: boolean;
  onRun: () => void;
  onConfigure?: (() => void) | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center">
      <ThreadDetailsControl
        variant="ghost"
        part="row"
        panel
        className="min-w-0 flex-1"
        disabled={disabled}
        onClick={onRun}
      >
        {children}
      </ThreadDetailsControl>
      {onConfigure ? (
        <div className="ml-1 shrink-0 border-l border-border/50 pl-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  part="icon"
                  variant="ghost"
                  disabled={disabled}
                  aria-label={`${label} options`}
                  onClick={onConfigure}
                />
              }
            >
              <SlidersHorizontalIcon aria-hidden className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="left">{label} options</TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
}
