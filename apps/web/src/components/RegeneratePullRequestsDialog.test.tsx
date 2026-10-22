import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("~/components/ui/button", () => ({ Button: "button" }));
vi.mock("~/components/ui/checkbox", () => ({ Checkbox: "input" }));
vi.mock("~/components/ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("~/components/ui/dialog", () => ({
  Dialog: "dialog",
  DialogPopup: "section",
  DialogHeader: "header",
  DialogTitle: "h2",
  DialogDescription: "p",
  DialogPanel: "main",
  DialogFooter: "footer",
}));

import { RegeneratePullRequestsDialog } from "./RegeneratePullRequestsDialog";
import type { RegeneratePullRequestCandidate } from "./GitActionsControl.logic";

const candidates: ReadonlyArray<RegeneratePullRequestCandidate> = [1, 2, 3].map((number) => ({
  url: `https://gitlab.com/group/repo/-/merge_requests/${number}`,
  number,
  title: `Request ${number}`,
  repository: "group/repo",
  headBranch: `feature/${number}`,
  baseBranch: "main",
}));
let renderer: ReactTestRenderer | undefined;
const onRegenerate =
  vi.fn<
    (
      selected: ReadonlyArray<RegeneratePullRequestCandidate>,
    ) => Promise<ReadonlyArray<{ url: string; message: string }>>
  >();
const onClose = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onRegenerate.mockReset().mockResolvedValue([]);
  onClose.mockReset();
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

async function openDialog() {
  await act(() => {
    renderer = create(
      <RegeneratePullRequestsDialog
        candidates={candidates}
        shortLabel="MR"
        canRegenerate
        isRegenerating={false}
        onRegenerate={onRegenerate}
        onClose={onClose}
      />,
    );
  });
}

async function select(number: number, checked: boolean) {
  await act(() =>
    renderer!.root
      .findByProps({
        "aria-label": `Regenerate MR #${number}: Request ${number}`,
      })
      .props.onCheckedChange(checked),
  );
}

async function submit() {
  await act(async () => {
    renderer!.root.findAllByType("button").at(-1)!.props.onClick();
  });
}

it("regenerates only selected requests, including after deselecting one", async () => {
  await openDialog();
  await select(1, true);
  await select(2, true);
  await select(3, true);
  await select(2, false);
  await submit();
  expect(onRegenerate).toHaveBeenCalledExactlyOnceWith([candidates[0], candidates[2]]);
  expect(onClose).toHaveBeenCalledOnce();
});

it("selects all requests together", async () => {
  await openDialog();
  await act(() =>
    renderer!.root.findByProps({ "aria-label": "Select all MRs" }).props.onCheckedChange(),
  );
  await submit();
  expect(onRegenerate).toHaveBeenCalledExactlyOnceWith(candidates);
});

it("keeps failures selected for retry without regenerating successful requests again", async () => {
  onRegenerate.mockResolvedValueOnce([{ url: candidates[1]!.url, message: "Request failed" }]);
  await openDialog();
  await select(1, true);
  await select(2, true);
  await submit();
  expect(onClose).not.toHaveBeenCalled();
  expect(renderer!.root.findByProps({ role: "alert" }).children).toEqual(["Request failed"]);
  await submit();
  expect(onRegenerate).toHaveBeenLastCalledWith([candidates[1]]);
  expect(onClose).toHaveBeenCalledOnce();
});
