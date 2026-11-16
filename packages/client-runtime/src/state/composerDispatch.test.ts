import { describe, expect, it } from "vite-plus/test";

import {
  alternateComposerDispatchAction,
  resolveComposerDispatchMode,
  compactionBlocksSteering,
  composerRunsDraftLocally,
} from "./composerDispatch.ts";

it("blocks steering for explicit compaction, and for automatic compaction unless the provider takes steers then", () => {
  const during = (
    text: string | undefined,
    attachments: ReadonlyArray<unknown> = [],
    steersDuringCompaction = true,
  ) =>
    compactionBlocksSteering({
      compactCommandIsActive: false,
      compactionRunning: true,
      steersDuringCompaction,
      run: { userMessageId: "user" },
      messages: [
        ...(text === undefined ? [] : [{ id: "user", text, attachments }]),
        { id: "later", text: "/compact" },
      ],
    });

  for (const text of ["/compact", "  /COMPACT  ", "/compact keep the debugging notes"]) {
    expect(during(text)).toBe(true);
  }
  for (const text of ["Read the code", "/compactify", "please /compact", undefined]) {
    expect(during(text)).toBe(false);
  }
  expect(during("/compact", [{}])).toBe(false);
  expect(during("Read the code", [], false)).toBe(true);

  expect(
    compactionBlocksSteering({
      compactCommandIsActive: true,
      compactionRunning: false,
      steersDuringCompaction: true,
      run: undefined,
      messages: undefined,
    }),
  ).toBe(true);
  expect(
    compactionBlocksSteering({
      compactCommandIsActive: false,
      compactionRunning: false,
      steersDuringCompaction: false,
      run: { userMessageId: "user" },
      messages: [{ id: "user", text: "/compact" }],
    }),
  ).toBe(false);
});

it("treats only the commands the composer runs itself as local", () => {
  const none = {
    holdsOnlyText: true,
    sideChat: false,
    usageLimits: false,
    codexFeedback: false,
    freshSession: false,
  };
  const all = {
    ...none,
    sideChat: true,
    usageLimits: true,
    codexFeedback: true,
    freshSession: true,
  };
  for (const text of ["/btw why?", "/usage-limits", "/feedback slow", "/clear"]) {
    expect(composerRunsDraftLocally({ ...all, text })).toBe(true);
    expect(composerRunsDraftLocally({ ...none, text })).toBe(false);
  }
  expect(composerRunsDraftLocally({ ...all, text: "fix the bug" })).toBe(false);
  expect(composerRunsDraftLocally({ ...all, holdsOnlyText: false, text: "/clear" })).toBe(false);
  expect(composerRunsDraftLocally({ ...all, holdsOnlyText: false, text: "/side why?" })).toBe(true);
});

describe("resolveComposerDispatchMode", () => {
  it("starts an ordinary turn while idle", () => {
    expect(resolveComposerDispatchMode({ running: false, alternateModifier: false })).toBe("auto");
  });

  it("queues by default and reserves alternate send for steering while running", () => {
    expect(resolveComposerDispatchMode({ running: true, alternateModifier: false })).toBe("queue");
    expect(resolveComposerDispatchMode({ running: true, alternateModifier: true })).toBe("steer");
  });

  it("queues as the alternate action when restarting is the default", () => {
    expect(
      resolveComposerDispatchMode({
        running: true,
        alternateModifier: false,
        activeTurnDefault: "restart",
      }),
    ).toBe("restart");
    expect(
      resolveComposerDispatchMode({
        running: true,
        alternateModifier: true,
        activeTurnDefault: "restart",
      }),
    ).toBe("queue");
  });
  it.each([
    ["queue", "steer"],
    ["steer", "queue"],
  ] as const)(
    "uses configured %s behavior only during a running turn",
    (activeTurnDefault, alternateAction) => {
      expect(
        resolveComposerDispatchMode({
          running: true,
          alternateModifier: false,
          activeTurnDefault,
        }),
      ).toBe(activeTurnDefault);
      expect(
        resolveComposerDispatchMode({
          running: true,
          alternateModifier: true,
          activeTurnDefault,
        }),
      ).toBe(alternateAction);
      expect(
        resolveComposerDispatchMode({
          running: false,
          alternateModifier: false,
          activeTurnDefault,
        }),
      ).toBe("auto");
      expect(
        resolveComposerDispatchMode({ running: false, alternateModifier: true, activeTurnDefault }),
      ).toBe("auto");
    },
  );

  it("names the alternate action so the affordance can be labelled", () => {
    expect(alternateComposerDispatchAction("queue")).toBe("steer");
    expect(alternateComposerDispatchAction("steer")).toBe("queue");
    expect(alternateComposerDispatchAction()).toBe("steer");
  });
});

it.each(["queue", "steer", "restart"] as const)(
  "queues when steering is unavailable with %s configured",
  (activeTurnDefault) => {
    expect(
      resolveComposerDispatchMode({
        running: true,
        alternateModifier: true,
        activeTurnDefault,
        canSteer: false,
      }),
    ).toBe("queue");
  },
);
