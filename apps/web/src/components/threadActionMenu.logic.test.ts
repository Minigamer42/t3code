import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])("gates lifecycle actions (reversed: %s, queued locally: %s)", (reversed, canOrganize) => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      canOrganize,
      isPinned: reversed,
      isSettled: reversed,
      isSnoozed: reversed,
    });
    const expected = reversed
      ? [
          "unpin",
          "unsettle",
          "unsnooze",
          "rename",
          "regenerate-title",
          "auto-settle",
          "archive",
          "delete",
        ]
      : [
          "pin",
          "settle",
          "snooze",
          "rename",
          "regenerate-title",
          "auto-settle",
          "archive",
          "delete",
        ];
    expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(
      canOrganize ? expected.slice(3) : expected,
    );
    if (!reversed)
      expect(
        items
          .find((item) => item.id === "snooze")
          ?.children?.every((child) => Boolean(child.disabled)),
      ).toBe(!canOrganize);
  });

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });
});
