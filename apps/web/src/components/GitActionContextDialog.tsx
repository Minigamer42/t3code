import { useState } from "react";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "./ui/dialog";
import { Textarea } from "./ui/textarea";

export function GitActionContextDialog({
  label,
  onRun,
  onClose,
  currentBranchAction,
}: {
  label: string;
  onRun: (instructions: string) => void;
  onClose: () => void;
  currentBranchAction?: {
    label: string;
    description?: string;
    onRun: (instructions: string) => void;
  };
}) {
  const [instructions, setInstructions] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className={currentBranchAction ? "max-w-xl" : undefined}>
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>
            Add context for this action alongside your repository instructions.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label className="flex flex-col gap-2 text-sm font-medium">
            Additional context (optional)
            <Textarea
              autoFocus
              value={instructions}
              maxLength={10_000}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="For example: explain the migration risk, or keep the API changes in a separate commit."
            />
          </label>
          {currentBranchAction?.description ? (
            <p className="text-sm text-muted-foreground">{currentBranchAction.description}</p>
          ) : null}
        </DialogPanel>
        <DialogFooter className="sm:flex-wrap">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          {currentBranchAction ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onClose();
                currentBranchAction.onRun(instructions.trim());
              }}
            >
              {currentBranchAction.label}
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={() => {
              onClose();
              onRun(instructions.trim());
            }}
          >
            {label}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
