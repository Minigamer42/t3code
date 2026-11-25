import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  scratch: false,
  projectVisible: true,
  update: vi.fn().mockResolvedValue({ _tag: "Success" }),
  refName: undefined as string | null | undefined,
  worktreePath: null as string | null,
}));

vi.mock("../../state/entities", () => ({
  useProjects: () =>
    [
      {
        id: "scratch",
        environmentId: "environment",
        title: "No project",
        workspaceRoot: "/scratch",
      },
      { id: "project", environmentId: "environment", title: "Project", workspaceRoot: "/repo" },
    ].filter((project) => project.id === "scratch" || state.projectVisible),
  useThreadShell: () => ({
    projectId: state.scratch ? "scratch" : "project",
    branch: "feature/saved",
    worktreePath: state.worktreePath,
  }),
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.update }));
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
    state.scratch = false;
    state.projectVisible = true;
    state.update.mockClear();
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

it("ignores project-list reconciliation after navigation but saves an explicit selection", async () => {
  state.scratch = true;
  state.projectVisible = true;
  state.refName = undefined;
  state.worktreePath = null;
  state.update.mockClear();
  const control = (id: string) => (
    <ThreadWorkspaceControl
      environmentId={EnvironmentId.make("environment")}
      threadId={ThreadId.make(id)}
    />
  );
  await using screen = await render(control("scratch-thread"));
  await screen.getByRole("combobox", { name: "Thread project" }).click();
  await expect.element(page.getByRole("option", { name: "No project", exact: true })).toBeVisible();
  state.scratch = false;
  await screen.rerender(control("project-thread"));
  await expect
    .element(screen.getByRole("combobox", { name: "Thread project" }))
    .toHaveTextContent("Project");
  state.projectVisible = false;
  await screen.rerender(control("project-thread"));
  await expect
    .element(screen.getByRole("combobox", { name: "Thread project" }))
    .toHaveTextContent("Choose project");
  expect(state.update).not.toHaveBeenCalled();
  state.projectVisible = true;
  await screen.rerender(control("project-thread"));
  await page.getByRole("option", { name: "No project", exact: true }).click();
  expect(state.update).toHaveBeenCalledExactlyOnceWith({
    environmentId: "environment",
    input: { threadId: "project-thread", projectId: "scratch" },
  });
});
