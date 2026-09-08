import type { VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildMenuItems, requiresForcePushConfirmation, resolveQuickAction } from "./gitActions.ts";

const divergedStatus: VcsStatusResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/rebased",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 2,
  behindCount: 1,
  pr: null,
};

describe("diverged git actions", () => {
  it("opens force-push confirmation as the primary action", () => {
    expect(resolveQuickAction(divergedStatus, false)).toEqual({
      label: "Push",
      disabled: false,
      kind: "open_push_dialog",
    });
  });

  it("enables the Push menu item for clean rewritten history", () => {
    expect(buildMenuItems(divergedStatus, false).find((item) => item.id === "push")).toMatchObject({
      disabled: false,
      dialogAction: "push",
    });
    expect(requiresForcePushConfirmation(divergedStatus)).toBe(true);
  });
});
