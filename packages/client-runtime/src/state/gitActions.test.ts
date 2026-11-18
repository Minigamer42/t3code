import {
  SourceControlProviderKind,
  type GitStackStatusResult,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sourceControlClients } from "../sourceControlClients.ts";
import {
  buildMenuItems,
  requiresForcePushConfirmation,
  getGitActionDisabledReason,
  resolveDefaultBranchActionDialogCopy,
  resolveQuickAction,
} from "./gitActions.ts";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

const gitLab = {
  sourceControlProvider: {
    kind: SourceControlProviderKind.make("gitlab"),
    name: "GitLab",
    baseUrl: "https://gitlab.com",
  },
};

const openPr = {
  number: 7,
  title: "Feature",
  url: "https://example.com/pr/7",
  baseRef: "main",
  headRef: "feature/test",
  state: "open" as const,
};

describe("git action copy", () => {
  it("says PR for a GitHub ref", () => {
    expect(resolveQuickAction(status({ aheadCount: 1 }), false).label).toBe("Push & create PR");
    expect(resolveQuickAction(status({ pr: openPr }), false).label).toBe("View PR");
    const [, , prItem] = buildMenuItems(status(), false);
    expect(prItem?.label).toBe("Create PR");
    expect(buildMenuItems(status(), false).find((item) => item.id === "commit")?.disabled).toBe(
      true,
    );
    expect(
      getGitActionDisabledReason({
        item: prItem!,
        gitStatus: status(),
        isBusy: false,
        hasOriginRemote: true,
      }),
    ).toBe("No local commits to include in a PR.");
  });

  it("says MR for a GitLab ref", () => {
    expect(resolveQuickAction(status({ ...gitLab, aheadCount: 1 }), false).label).toBe(
      "Push & create MR",
    );
    expect(
      resolveQuickAction(status({ ...gitLab, hasWorkingTreeChanges: true }), false).label,
    ).toBe("Commit, push & MR");
    expect(resolveQuickAction(status({ ...gitLab, pr: openPr }), false).label).toBe("View MR");
    const [, , prItem] = buildMenuItems(status(gitLab), false);
    expect(prItem?.label).toBe("Create MR");
    expect(buildMenuItems(status(gitLab), false).find((item) => item.id === "push")?.label).toBe(
      "Push",
    );
    expect(
      getGitActionDisabledReason({
        item: prItem!,
        gitStatus: status(gitLab),
        isBusy: false,
        hasOriginRemote: true,
      }),
    ).toBe("No local commits to include in an MR.");
    expect(
      buildMenuItems(status({ ...gitLab, aheadCount: 1 }), false).find((item) => item.id === "pr")
        ?.label,
    ).toBe("Push & create MR");
    const dirtyItems = buildMenuItems(status({ ...gitLab, hasWorkingTreeChanges: true }), false);
    expect(dirtyItems.find((item) => item.id === "pr")).toMatchObject({
      disabled: false,
      action: "commit_push_pr",
      label: "Commit, push & create MR",
    });
    expect(dirtyItems.find((item) => item.id === "push")).toMatchObject({
      disabled: false,
      action: "commit_push",
      label: "Commit & push",
    });
    const emptyDefault = buildMenuItems(
      status({ refName: "development", isDefaultRef: true, aheadCount: 0, aheadOfDefaultCount: 0 }),
      false,
    );
    for (const id of ["branch", "push", "pr"]) {
      expect(emptyDefault.find((item) => item.id === id)?.disabled).toBe(true);
    }
    for (const refName of [null, "main"]) {
      const items = buildMenuItems(
        status({
          ...gitLab,
          refName,
          isDefaultRef: refName === "main",
          hasWorkingTreeChanges: true,
        }),
        false,
      );
      expect(items[0]).toMatchObject({ id: "branch", disabled: false, action: "create_branch" });
      expect(items.find((item) => item.id === "push")).toMatchObject({
        disabled: false,
        featureBranch: true,
      });
      expect(items.find((item) => item.id === "pr")).toMatchObject({
        disabled: false,
        featureBranch: true,
      });
    }
  });

  it.each([
    { behind: 0, dirty: false, current: 1, restack: false },
    { behind: 2, dirty: false, current: 1, restack: true },
    { behind: 0, dirty: true, current: 1, restack: true },
    { behind: 0, dirty: true, current: 2, restack: false },
  ])(
    "uses parent ancestry and pending commits for stack publishing copy: %j",
    ({ behind, dirty, current, restack }) => {
      const names = ["first", "second", "third"];
      const stack: GitStackStatusResult = {
        managed: true,
        base: "main",
        baseIsDefault: true,
        remote: "origin",
        operation: null,
        layers: names.map((branch, index) => ({
          branch,
          parent: names[index - 1] ?? "main",
          headSha: branch,
          current: index === current,
          needsRestack: index === 2 && behind > 0,
          behindCount: index === 2 ? behind : 0,
          hasChanges: false,
          worktreePath: null,
          pullRequest: null,
        })),
      };
      const gitStatus = status({
        ...gitLab,
        refName: names[current]!,
        hasWorkingTreeChanges: dirty,
        aheadCount: 1,
      });
      const items = buildMenuItems(gitStatus, false, true, stack);
      expect(items.find((item) => item.id === "push")?.label).toBe(
        restack
          ? dirty
            ? "Commit, restack & push"
            : "Restack & push"
          : dirty
            ? "Commit & push"
            : "Push",
      );
      expect(items.find((item) => item.id === "pr")?.label).toBe(
        restack
          ? dirty
            ? "Commit, restack, push & create MR"
            : "Restack, push & create MR"
          : dirty
            ? "Commit, push & create MR"
            : "Push & create MR",
      );
      const withCurrentReview = { ...gitStatus, aheadCount: 0, pr: openPr };
      expect(
        buildMenuItems(withCurrentReview, false, true, stack).find((item) => item.id === "pr"),
      ).toMatchObject({
        kind: "open_dialog",
        disabled: false,
        action: "commit_push_pr",
      });
      const completeStack = {
        ...stack,
        layers: stack.layers.map((layer) => ({
          ...layer,
          pullRequest: { number: 1, url: openPr.url, state: "open" as const },
        })),
      };
      expect(
        buildMenuItems(withCurrentReview, false, true, completeStack).find(
          (item) => item.id === "pr",
        )?.kind,
      ).toBe("open_pr");
      const onlyUpperMissing = {
        ...completeStack,
        layers: completeStack.layers.map((layer, index) =>
          index > current ? { ...layer, pullRequest: null } : layer,
        ),
      };
      expect(
        buildMenuItems(withCurrentReview, false, true, onlyUpperMissing).find(
          (item) => item.id === "pr",
        )?.kind,
      ).toBe("open_pr");
      const quick = resolveQuickAction(gitStatus, false, false, true, stack);
      expect(quick.label.toLowerCase().includes("restack")).toBe(restack);
      if (behind > 0) {
        const clean = { ...gitStatus, aheadCount: 0, pr: openPr };
        expect(
          buildMenuItems(clean, false, true, stack).find((item) => item.id === "push")?.disabled,
        ).toBe(false);
        expect(resolveQuickAction(clean, false, false, true, stack)).toMatchObject({
          label: "Restack & push",
          action: "push",
          disabled: false,
        });
      }
    },
  );

  it("names the host's change request in the default-branch dialog", () => {
    const input = { action: "commit_push_pr", branchName: "main", includesCommit: true } as const;
    expect(
      resolveDefaultBranchActionDialogCopy({
        ...input,
        terminology: sourceControlClients.get("github").changeRequest,
      }).title,
    ).toBe("Commit, push & create PR from default branch?");
    expect(
      resolveDefaultBranchActionDialogCopy({
        ...input,
        terminology: sourceControlClients.get("gitlab").changeRequest,
      }).continueLabel,
    ).toBe("Commit, push & create MR");
  });
});

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
