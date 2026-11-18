import { useState } from "react";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { StackLayerSplitPicker } from "./StackLayerSplitPicker";

vi.mock("~/state/git", () => ({
  gitEnvironment: { rewriteableCommits: () => null },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    isPending: false,
    error: null,
    data: {
      headSha: "4".repeat(40),
      commits: Array.from({ length: 4 }, (_, index) => ({
        sha: String(index + 1).repeat(40),
        shortSha: String(index + 1).repeat(7),
        subject: `Change ${index + 1}`,
      })),
    },
  }),
}));

function SplitPicker({ onChange }: { onChange: (points: string[], headSha: string) => void }) {
  const [points, setPoints] = useState<string[]>([]);
  return (
    <StackLayerSplitPicker
      environmentId={EnvironmentId.make("test")}
      cwd="/repo"
      points={points}
      onChange={(next, head) => {
        setPoints(next);
        onChange(next, head);
      }}
    />
  );
}

it("selects multiple boundaries in commit order and lets them be removed before saving", async () => {
  const onChange = vi.fn();
  await using screen = await render(<SplitPicker onChange={onChange} />);
  await userEvent.click(screen.getByRole("button", { name: "Split after 3333333: Change 3" }));
  await userEvent.click(screen.getByRole("button", { name: "Split after 1111111: Change 1" }));
  expect(onChange).toHaveBeenLastCalledWith(["1".repeat(40), "3".repeat(40)], "4".repeat(40));
  await expect
    .element(screen.getByText("2 new layers · existing commits are preserved"))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Split after 1111111: Change 1" }))
    .toHaveAttribute("aria-pressed", "true");
  await userEvent.click(screen.getByRole("button", { name: "Split after 1111111: Change 1" }));
  expect(onChange).toHaveBeenLastCalledWith(["3".repeat(40)], "4".repeat(40));
  await expect.element(screen.getByText("Current branch tip")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Split after 4444444: Change 4" }))
    .not.toBeInTheDocument();
});
