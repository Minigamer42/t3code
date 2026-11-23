import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  refName: undefined as string | null | undefined,
  worktreePath: null as string | null,
}));

vi.mock("../../state/entities", () => ({
  useProjects: () => [
    { id: "project", environmentId: "environment", title: "Project", workspaceRoot: "/repo" },
  ],
  useThreadShell: () => ({
    projectId: "project",
    branch: "feature/saved",
    worktreePath: state.worktreePath,
  }),
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, error: null, isPending: false, refresh: vi.fn() }),
  useEnvironmentQuerySelector: (_atom: unknown, select: (result: unknown) => unknown) =>
    select(
      state.refName === undefined
        ? AsyncResult.initial()
        : AsyncResult.success({ isRepo: true, refName: state.refName }),
    ),
}));
vi.mock("../../state/vcs", () => ({
  vcsEnvironment: { status: () => null, listWorktrees: () => null },
}));
vi.mock("../../state/threads", () => ({ threadEnvironment: { updateMetadata: null } }));

import { ThreadWorkspaceControl } from "./ThreadWorkspaceControl";

it.each([null, "/repo/worktrees/atlas"])(
  "tracks the live branch for checkout %s without waiting for thread metadata",
  async (worktreePath) => {
    state.worktreePath = worktreePath;
    state.refName = undefined;
    const control = () => (
      <ThreadWorkspaceControl
        environmentId={EnvironmentId.make("environment")}
        threadId={ThreadId.make("thread")}
      />
    );
    await using screen = await render(control());
    const worktree = screen.getByRole("combobox", { name: "Thread worktree" });
    const checkout = worktreePath === null ? "repo" : "atlas";
    await expect.element(worktree).toHaveTextContent(`${checkout} · feature/saved`);
    state.refName = "development";
    await screen.rerender(control());
    await expect.element(worktree).toHaveTextContent(`${checkout} · development`);
    state.refName = "feature/switched";
    await screen.rerender(control());
    await expect.element(worktree).toHaveTextContent(`${checkout} · feature/switched`);
    state.refName = null;
    await screen.rerender(control());
    await expect.element(worktree).toHaveTextContent(`${checkout} · Detached HEAD`);
  },
);
