import "~/index.css";
import { useState } from "react";
import { GitActionRow } from "./GitActionRow";
import { GitActionContextDialog } from "./GitActionContextDialog";
import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { PublishRepositoryDialog } from "./GitActionsControl";

const publish = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      versionControlSystems: [],
      sourceControlProviders: [
        {
          kind: SourceControlProviderKind.make("github"),
          label: "GitHub",
          status: "available",
          version: Option.none(),
          installHint: "Install gh",
          detail: Option.none(),
          auth: {
            status: "authenticated",
            account: Option.none(),
            host: Option.none(),
            detail: Option.none(),
          },
        },
      ],
    },
  }),
}));

vi.mock("~/state/sourceControlActions", () => ({
  useGitStackedAction: vi.fn(),
  useSourceControlActionRunning: vi.fn(),
  useVcsInitAction: vi.fn(),
  useVcsPullAction: vi.fn(),
  useSourceControlPublishRepositoryAction: () => ({
    isAllowed: true,
    isPending: false,
    run: publish.run,
  }),
}));

function setup() {
  publish.run.mockReset();
  publish.run.mockReturnValue(new Promise(() => {}));
}

it("keeps composition Enter in the repository path from publishing", async () => {
  setup();
  await using _screen = await render(
    <PublishRepositoryDialog
      open
      onOpenChange={() => {}}
      environmentId={null}
      threadRef={null}
      gitCwd="/repo"
      offeredProviders={undefined}
    />,
  );
  await page.getByRole("button", { name: "Next" }).click();
  const path = page.getByRole("textbox", { name: "Repository" });
  await path.fill("octo/repo");

  for (const nativeEvent of [{ isComposing: true }, { keyCode: 229 }]) {
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      ...nativeEvent,
      bubbles: true,
      cancelable: true,
    });
    await act(() => path.element().dispatchEvent(event));
    expect(publish.run).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  }

  await userEvent.keyboard("{Enter}");
  expect(publish.run).toHaveBeenCalledOnce();
});

function ConfigurableAction({ onRun }: { onRun: (instructions?: string) => void }) {
  const [configuring, setConfiguring] = useState(false);
  return (
    <>
      <GitActionRow
        label="Create MR"
        disabled={false}
        onRun={() => onRun()}
        onConfigure={() => setConfiguring(true)}
      >
        Create MR
      </GitActionRow>
      {configuring ? (
        <GitActionContextDialog
          label="Create MR"
          onRun={onRun}
          onClose={() => setConfiguring(false)}
        />
      ) : null}
    </>
  );
}

it("keeps quick actions separate from context editing and cancellation", async () => {
  const onRun = vi.fn();
  await using screen = await render(<ConfigurableAction onRun={onRun} />);
  await screen.getByRole("button", { name: "Create MR options", exact: true }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  expect(onRun).not.toHaveBeenCalled();
  const context = page.getByRole("textbox", { name: "Additional context (optional)" });
  await expect.element(context).toHaveFocus();
  await context.fill("  Explain the migration risk.  ");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(onRun).not.toHaveBeenCalled();
  await screen.getByRole("button", { name: "Create MR options", exact: true }).click();
  await expect.element(context).toHaveValue("");
  await context.fill("  Explain the migration risk.  ");
  await page.getByRole("dialog").getByRole("button", { name: "Create MR", exact: true }).click();
  expect(onRun).toHaveBeenCalledExactlyOnceWith("Explain the migration risk.");
  await screen.getByRole("button", { name: "Create MR", exact: true }).click();
  expect(onRun).toHaveBeenLastCalledWith();
  expect(onRun).toHaveBeenCalledTimes(2);
});
