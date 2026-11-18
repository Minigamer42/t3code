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
}: {
  label: string;
  onRun: (instructions: string) => void;
  onClose: () => void;
}) {
  const [instructions, setInstructions] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
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
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
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
