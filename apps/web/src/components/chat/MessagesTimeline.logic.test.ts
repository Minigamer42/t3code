import { describe, expect, it } from "vitest";
import {
  computeStableMessagesTimelineRows,
  computeMessageDurationStart,
  deriveMessagesTimelineRows,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
} from "./MessagesTimeline.logic";

describe("computeMessageDurationStart", () => {
  it("returns message createdAt when there is no preceding user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:05Z",
        completedAt: "2026-01-01T00:00:10Z",
      },
    ]);
    expect(result).toEqual(new Map([["a1", "2026-01-01T00:00:05Z"]]));
  });

  it("uses assistant message createdAt for the segment duration start", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:30Z"],
      ]),
    );
  });

  it("uses each later assistant message createdAt as its own duration start", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z", turnId: "turn-1" as never },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
        turnId: "turn-1" as never,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        completedAt: "2026-01-01T00:00:55Z",
        turnId: "turn-2" as never,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:30Z"],
        ["a2", "2026-01-01T00:00:55Z"],
      ]),
    );
  });

  it("keeps subsequent assistant responses in the same turn on their own createdAt", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z", turnId: "turn-1" as never },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
        turnId: "turn-1" as never,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:08:00Z",
        completedAt: "2026-01-01T00:08:00Z",
        turnId: "turn-1" as never,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:30Z"],
        ["a2", "2026-01-01T00:08:00Z"],
      ]),
    );
  });

  it("does not advance the boundary for a streaming message without completedAt", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      { id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:30Z" },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        completedAt: "2026-01-01T00:00:55Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:30Z"],
        ["a2", "2026-01-01T00:00:55Z"],
      ]),
    );
  });

  it("resets the boundary on a new user message", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
      { id: "u2", role: "user", createdAt: "2026-01-01T00:01:00Z" },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:01:20Z",
        completedAt: "2026-01-01T00:01:20Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:30Z"],
        ["u2", "2026-01-01T00:01:00Z"],
        ["a2", "2026-01-01T00:01:20Z"],
      ]),
    );
  });

  it("handles system messages without affecting the boundary", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      { id: "s1", role: "system", createdAt: "2026-01-01T00:00:01Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["s1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:30Z"],
      ]),
    );
  });

  it("returns empty map for empty input", () => {
    expect(computeMessageDurationStart([])).toEqual(new Map());
  });
});

describe("normalizeCompactToolLabel", () => {
  it("removes trailing completion wording from command labels", () => {
    expect(normalizeCompactToolLabel("Ran command complete")).toBe("Ran command");
  });

  it("removes trailing completion wording from other labels", () => {
    expect(normalizeCompactToolLabel("Read file completed")).toBe("Read file");
  });
});

describe("resolveAssistantMessageCopyState", () => {
  it("returns enabled copy state for completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Ship it",
        streaming: false,
      }),
    ).toEqual({
      text: "Ship it",
      visible: true,
    });
  });

  it("hides copy while an assistant message is still streaming", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Still streaming",
        streaming: true,
      }),
    ).toEqual({
      text: "Still streaming",
      visible: false,
    });
  });

  it("hides copy for empty completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "   ",
        streaming: false,
      }),
    ).toEqual({
      text: null,
      visible: false,
    });
  });

  it("hides copy for non-terminal assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: false,
        text: "Interim thought",
        streaming: false,
      }),
    ).toEqual({
      text: "Interim thought",
      visible: false,
    });
  });
});

describe("deriveMessagesTimelineRows", () => {
  it("labels the working row as waiting before the first active turn output", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [],
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.at(-1)).toMatchObject({
      kind: "working",
      phaseLabel: "Waiting for response",
      phaseStartedAt: "2026-01-01T00:00:00Z",
      totalStartedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("uses the working fallback label before the first active turn output", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [],
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      workingFallbackLabel: "Preparing worktree",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.at(-1)).toMatchObject({
      kind: "working",
      phaseLabel: "Preparing worktree",
      phaseStartedAt: "2026-01-01T00:00:00Z",
      totalStartedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("uses the fallback phase start before the first active turn output", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [],
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      workingFallbackLabel: "Thinking",
      workingFallbackStartedAt: "2026-01-01T00:00:05Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.at(-1)).toMatchObject({
      kind: "working",
      phaseLabel: "Thinking",
      phaseStartedAt: "2026-01-01T00:00:05Z",
      totalStartedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("ignores older output while waiting for a new turn id", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-old-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "assistant-old" as never,
            role: "assistant",
            text: "Previous response.",
            turnId: "turn-old" as never,
            createdAt: "2026-01-01T00:00:00Z",
            completedAt: "2026-01-01T00:00:02Z",
            streaming: false,
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: true,
      activeTurnId: null,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.at(-1)).toMatchObject({
      kind: "working",
      phaseLabel: "Waiting for response",
      phaseStartedAt: "2026-01-01T00:01:00Z",
      totalStartedAt: "2026-01-01T00:01:00Z",
    });
  });

  it("does not derive the working phase from prior output before the current dispatch start", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-old-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "assistant-old" as never,
            role: "assistant",
            text: "Previous response.",
            turnId: "turn-old" as never,
            createdAt: "2026-01-01T00:00:00Z",
            streaming: true,
          },
        },
        {
          id: "work-old-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:01Z",
          entry: {
            id: "work-old",
            createdAt: "2026-01-01T00:00:01Z",
            label: "Thinking",
            tone: "thinking",
            turnId: "turn-old" as never,
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: true,
      activeTurnId: null,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      workingFallbackLabel: "Sending",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.at(-1)).toMatchObject({
      kind: "working",
      phaseLabel: "Sending",
      phaseStartedAt: "2026-01-01T00:01:00Z",
      totalStartedAt: "2026-01-01T00:01:00Z",
    });
  });

  it("labels the working row as thinking after non-tool work output arrives", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:04Z",
          entry: {
            id: "thinking-1",
            createdAt: "2026-01-01T00:00:04Z",
            label: "Thinking",
            tone: "thinking",
            turnId: "turn-1" as never,
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: true,
      activeTurnId: "turn-1" as never,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.at(-1)).toMatchObject({
      kind: "working",
      phaseLabel: "Thinking",
      phaseStartedAt: "2026-01-01T00:00:04Z",
      totalStartedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("starts fallback thinking at the first active output instead of the turn start", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-1-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:09Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:09Z",
            streaming: false,
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: true,
      activeTurnId: "turn-1" as never,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.at(-1)).toMatchObject({
      kind: "working",
      phaseLabel: "Thinking",
      phaseStartedAt: "2026-01-01T00:00:09Z",
      totalStartedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("labels the working row from the active assistant response", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-1-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:05Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "Streaming",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:05Z",
            streaming: true,
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: true,
      activeTurnId: "turn-1" as never,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.at(-1)).toMatchObject({
      kind: "working",
      phaseLabel: "Responding",
      phaseStartedAt: "2026-01-01T00:00:05Z",
      totalStartedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("labels a single active tool call by its concrete activity", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:10Z",
          entry: {
            id: "tool-1",
            createdAt: "2026-01-01T00:00:10Z",
            label: "Tool started",
            tone: "tool",
            itemType: "web_search",
            toolStatus: "inProgress",
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.at(-1)).toMatchObject({
      kind: "working",
      phaseLabel: "Searching web",
      phaseStartedAt: "2026-01-01T00:00:10Z",
    });
  });

  it.each([
    ["command_execution", "Running command"],
    ["file_change", "Editing files"],
    ["mcp_tool_call", "Using MCP tool"],
    ["dynamic_tool_call", "Using tool"],
    ["collab_agent_tool_call", "Waiting for subagent"],
    ["web_search", "Searching web"],
    ["image_view", "Viewing image"],
  ] as const)("labels active %s work", (itemType, phaseLabel) => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:10Z",
          entry: {
            id: "tool-1",
            createdAt: "2026-01-01T00:00:10Z",
            label: "Tool started",
            tone: "tool",
            itemType,
            toolStatus: "inProgress",
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.at(-1)).toMatchObject({
      kind: "working",
      phaseLabel,
      phaseStartedAt: "2026-01-01T00:00:10Z",
    });
  });

  it("groups concurrent active tool calls", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:10Z",
          entry: {
            id: "tool-1",
            createdAt: "2026-01-01T00:00:10Z",
            label: "Searching web",
            tone: "tool",
            itemType: "web_search",
            toolStatus: "inProgress",
          },
        },
        {
          id: "work-2",
          kind: "work",
          createdAt: "2026-01-01T00:00:12Z",
          entry: {
            id: "tool-2",
            createdAt: "2026-01-01T00:00:12Z",
            label: "Viewing image",
            tone: "tool",
            itemType: "image_view",
            toolStatus: "inProgress",
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.at(-1)).toMatchObject({
      kind: "working",
      phaseLabel: "Running 2 tool calls",
      phaseStartedAt: "2026-01-01T00:00:10Z",
    });
  });

  it("starts thinking after a completed tool at the tool completion time", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:10Z",
          entry: {
            id: "tool-1",
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:18Z",
            label: "Searched web",
            tone: "tool",
            itemType: "web_search",
            toolStatus: "completed",
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      completionSummary: null,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.at(-1)).toMatchObject({
      kind: "working",
      phaseLabel: "Thinking",
      phaseStartedAt: "2026-01-01T00:00:18Z",
    });
  });

  it("only enables assistant copy for the terminal assistant message in a turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-1-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Write a poem",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "I should ground this first.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            completedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Here is the poem.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            completedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      completionDividerBeforeEntryId: "assistant-final-entry",
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows).toHaveLength(2);
    expect(assistantRows[0]?.showAssistantCopyButton).toBe(false);
    expect(assistantRows[1]?.showAssistantCopyButton).toBe(true);
    expect(assistantRows[1]?.showCompletionDivider).toBe(true);
  });

  it("marks only the active assistant turn as streaming for copy controls", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-one-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-one" as never,
            role: "assistant",
            text: "Earlier response.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            completedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-two-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-two" as never,
            role: "assistant",
            text: "Active response.",
            turnId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:20Z",
            completedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      completionDividerBeforeEntryId: "assistant-two-entry",
      completionSummary: "done",
      isWorking: false,
      activeTurnInProgress: true,
      activeTurnId: "turn-2" as never,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows[0]?.assistantCopyStreaming).toBe(false);
    expect(assistantRows[0]?.completionSummary).toBeNull();
    expect(assistantRows[1]?.assistantCopyStreaming).toBe(true);
    expect(assistantRows[1]?.completionSummary).toBe("done");
  });

  it("uses the total response boundary for the completed terminal assistant message", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Do it",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-one-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-one" as never,
            role: "assistant",
            text: "First chunk.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            completedAt: "2026-01-01T00:00:12Z",
            streaming: false,
          },
        },
        {
          id: "assistant-two-entry",
          kind: "message",
          createdAt: "2026-01-01T00:08:00Z",
          message: {
            id: "assistant-two" as never,
            role: "assistant",
            text: "Final chunk.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:08:00Z",
            completedAt: "2026-01-01T00:08:03Z",
            streaming: false,
          },
        },
      ],
      completionDividerBeforeEntryId: "assistant-two-entry",
      completionSummary: "Worked for 8m 3s",
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows[0]?.durationStart).toBe("2026-01-01T00:00:10Z");
    expect(assistantRows[1]?.durationStart).toBe("2026-01-01T00:00:00Z");
  });

  it("projects assistant diff summaries and user revert counts onto the affected rows", () => {
    const assistantTurnDiffSummary = {
      turnId: "turn-1" as never,
      completedAt: "2026-01-01T00:00:30Z",
      assistantMessageId: "assistant-1" as never,
      checkpointTurnCount: 2,
      files: [{ path: "src/index.ts", additions: 3, deletions: 1 }],
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Do the thing",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "Done",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            completedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map([
        ["assistant-1" as never, assistantTurnDiffSummary],
      ]),
      revertTurnCountByUserMessageId: new Map([["user-1" as never, 1]]),
    });

    const userRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "user",
    );
    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(userRow?.revertTurnCount).toBe(1);
    expect(assistantRow?.assistantTurnDiffSummary).toBe(assistantTurnDiffSummary);
  });
});

describe("computeStableMessagesTimelineRows", () => {
  it("returns the previous result when row order and content are unchanged", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      turnId: null,
      createdAt: "2026-01-01T00:00:10Z",
      streaming: false,
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-user-1",
          kind: "message",
          createdAt: firstUserMessage.createdAt,
          message: firstUserMessage,
        },
        {
          id: "entry-user-2",
          kind: "message",
          createdAt: secondUserMessage.createdAt,
          message: secondUserMessage,
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const initial = computeStableMessagesTimelineRows(rows, {
      byId: new Map(),
      result: [],
    });

    const repeated = computeStableMessagesTimelineRows(rows, initial);

    expect(repeated).toBe(initial);
    expect(repeated.result).toBe(initial.result);
  });

  it("reuses work rows when equivalent timeline derivations create new grouped arrays", () => {
    const firstWorkEntry = {
      id: "work-1",
      createdAt: "2026-01-01T00:00:00Z",
      label: "thinking",
      detail: "Inspecting repository state",
      tone: "thinking" as const,
    };
    const secondWorkEntry = {
      id: "work-2",
      createdAt: "2026-01-01T00:00:01Z",
      label: "read",
      detail: "Reading package.json",
      tone: "tool" as const,
    };

    const createRows = () =>
      deriveMessagesTimelineRows({
        timelineEntries: [
          {
            id: "entry-work-1",
            kind: "work",
            createdAt: firstWorkEntry.createdAt,
            entry: firstWorkEntry,
          },
          {
            id: "entry-work-2",
            kind: "work",
            createdAt: secondWorkEntry.createdAt,
            entry: secondWorkEntry,
          },
        ],
        completionDividerBeforeEntryId: null,
        isWorking: false,
        activeTurnStartedAt: null,
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });

    const firstRows = createRows();
    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });
    const secondRows = createRows();

    expect(secondRows[0]).not.toBe(firstRows[0]);

    const repeated = computeStableMessagesTimelineRows(secondRows, initial);

    expect(repeated).toBe(initial);
    expect(repeated.result[0]).toBe(initial.result[0]);
  });

  it("returns a new result when row order changes without content changes", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      turnId: null,
      createdAt: "2026-01-01T00:00:10Z",
      streaming: false,
    };

    const firstRows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-user-1",
          kind: "message",
          createdAt: firstUserMessage.createdAt,
          message: firstUserMessage,
        },
        {
          id: "entry-user-2",
          kind: "message",
          createdAt: secondUserMessage.createdAt,
          message: secondUserMessage,
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });

    const reordered = computeStableMessagesTimelineRows([firstRows[1]!, firstRows[0]!], initial);

    expect(reordered).not.toBe(initial);
    expect(reordered.result).toEqual([initial.result[1], initial.result[0]]);
  });
});
