import * as Equal from "effect/Equal";
import { type TimelineEntry, type WorkLogEntry } from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import { type MessageId, type TurnId } from "@t3tools/contracts";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  turnId?: TurnId | null | undefined;
  completedAt?: string | undefined;
}

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showCompletionDivider: boolean;
      completionSummary: string | null;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      revertTurnCount?: number | undefined;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      kind: "working";
      id: string;
      createdAt: string | null;
      phaseLabel: string;
      phaseStartedAt: string | null;
      totalStartedAt: string | null;
    };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
      result.set(message.id, lastBoundary);
      continue;
    }

    if (message.role !== "assistant") {
      result.set(message.id, lastBoundary ?? message.createdAt);
      continue;
    }

    result.set(message.id, message.createdAt);
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  return {
    text: hasText ? text : null,
    visible: showCopyButton && hasText && !streaming,
  };
}

function deriveTerminalAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>) {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.turnId
      ? `turn:${message.turnId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

function computeTerminalAssistantDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const responseBoundaryByKey = new Map<string, string>();
  const terminalAssistantIdByKey = new Map<string, string>();
  let lastBoundary: string | null = null;
  let nullTurnResponseIndex = 0;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.turnId
      ? `turn:${message.turnId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    if (!responseBoundaryByKey.has(responseKey)) {
      responseBoundaryByKey.set(responseKey, lastBoundary ?? message.createdAt);
    }
    terminalAssistantIdByKey.set(responseKey, message.id);
  }

  const result = new Map<string, string>();
  for (const [responseKey, messageId] of terminalAssistantIdByKey) {
    const boundary = responseBoundaryByKey.get(responseKey);
    if (boundary) {
      result.set(messageId, boundary);
    }
  }
  return result;
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  completionDividerBeforeEntryId: string | null;
  completionSummary?: string | null;
  isWorking: boolean;
  activeTurnInProgress?: boolean;
  activeTurnId?: TurnId | null;
  activeTurnStartedAt: string | null;
  workingFallbackLabel?: string | null;
  workingFallbackStartedAt?: string | null;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    input.timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const terminalDurationStartByMessageId = computeTerminalAssistantDurationStart(
    input.timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(input.timelineEntries);

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        if (!nextEntry || nextEntry.kind !== "work") break;
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      nextRows.push({
        kind: "work",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        groupedEntries,
      });
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    const assistantTurnStillInProgress =
      timelineEntry.message.role === "assistant" &&
      input.activeTurnInProgress === true &&
      input.activeTurnId != null &&
      timelineEntry.message.turnId === input.activeTurnId;

    const showCompletionDivider =
      timelineEntry.message.role === "assistant" &&
      input.completionDividerBeforeEntryId === timelineEntry.id;

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart:
        timelineEntry.message.role === "assistant" &&
        terminalAssistantMessageIds.has(timelineEntry.message.id) &&
        !timelineEntry.message.streaming
          ? (terminalDurationStartByMessageId.get(timelineEntry.message.id) ??
            durationStartByMessageId.get(timelineEntry.message.id) ??
            timelineEntry.message.createdAt)
          : (durationStartByMessageId.get(timelineEntry.message.id) ??
            timelineEntry.message.createdAt),
      showCompletionDivider,
      completionSummary: showCompletionDivider ? (input.completionSummary ?? null) : null,
      showAssistantCopyButton:
        timelineEntry.message.role === "assistant" &&
        terminalAssistantMessageIds.has(timelineEntry.message.id),
      assistantCopyStreaming: timelineEntry.message.streaming || assistantTurnStillInProgress,
      assistantTurnDiffSummary:
        timelineEntry.message.role === "assistant"
          ? input.turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
          : undefined,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? input.revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
    });
  }

  if (input.isWorking) {
    const workingPhase = deriveWorkingPhase({
      timelineEntries: input.timelineEntries,
      activeTurnId: input.activeTurnId ?? null,
      totalStartedAt: input.activeTurnStartedAt,
      fallbackLabel: input.workingFallbackLabel ?? null,
      fallbackStartedAt: input.workingFallbackStartedAt ?? null,
    });
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
      phaseLabel: workingPhase.label,
      phaseStartedAt: workingPhase.startedAt,
      totalStartedAt: input.activeTurnStartedAt,
    });
  }

  return nextRows;
}

function deriveWorkingPhase(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  activeTurnId: TurnId | null;
  totalStartedAt: string | null;
  fallbackLabel: string | null;
  fallbackStartedAt: string | null;
}): { label: string; startedAt: string | null } {
  const firstOutputAt = firstActiveTurnOutputAt({
    timelineEntries: input.timelineEntries,
    activeTurnId: input.activeTurnId,
    startedAt: input.totalStartedAt,
  });
  if (!firstOutputAt) {
    const hasFallbackLabel = input.fallbackLabel !== null && input.fallbackLabel.trim().length > 0;
    return {
      label: input.fallbackLabel ?? "Waiting for response",
      startedAt: hasFallbackLabel
        ? (input.fallbackStartedAt ?? input.totalStartedAt)
        : input.totalStartedAt,
    };
  }

  const activeToolEntries = input.timelineEntries.flatMap((entry) =>
    entry.kind === "work" &&
    entry.entry.toolStatus === "inProgress" &&
    isActiveWorkWindowEntry({
      activeTurnId: input.activeTurnId,
      startedAt: input.totalStartedAt,
      turnId: entry.entry.turnId,
      createdAt: entry.entry.createdAt,
    })
      ? [entry.entry]
      : [],
  );
  if (activeToolEntries.length > 1) {
    return {
      label: `Running ${activeToolEntries.length.toLocaleString()} tool calls`,
      startedAt: earliestWorkEntryStart(activeToolEntries),
    };
  }
  if (activeToolEntries.length === 1) {
    const activeToolEntry = activeToolEntries[0];
    if (!activeToolEntry) {
      return { label: input.fallbackLabel ?? "Thinking", startedAt: input.totalStartedAt };
    }
    return {
      label: workingToolPhaseLabel(activeToolEntry),
      startedAt: activeToolEntry.createdAt,
    };
  }

  let current: { label: string; startedAt: string | null } | null = null;
  const setCurrent = (candidate: { label: string; startedAt: string | null }) => {
    if (!candidate.startedAt) {
      if (!current) current = candidate;
      return;
    }
    if (!current?.startedAt || candidate.startedAt.localeCompare(current.startedAt) >= 0) {
      current = candidate;
    }
  };

  for (const entry of input.timelineEntries) {
    if (entry.kind === "message") {
      if (
        entry.message.role === "assistant" &&
        entry.message.streaming &&
        isActiveWorkWindowEntry({
          activeTurnId: input.activeTurnId,
          startedAt: input.totalStartedAt,
          turnId: entry.message.turnId,
          createdAt: entry.message.createdAt,
        })
      ) {
        setCurrent({ label: "Responding", startedAt: entry.message.createdAt });
      }
      continue;
    }

    if (entry.kind !== "work") {
      continue;
    }
    if (
      !isActiveWorkWindowEntry({
        activeTurnId: input.activeTurnId,
        startedAt: input.totalStartedAt,
        turnId: entry.entry.turnId,
        createdAt: entry.entry.createdAt,
      })
    ) {
      continue;
    }

    if (entry.entry.tone === "thinking") {
      setCurrent({
        label: workingThinkingPhaseLabel(entry.entry) ?? input.fallbackLabel ?? "Thinking",
        startedAt: entry.entry.updatedAt ?? entry.entry.createdAt,
      });
      continue;
    }

    if (
      entry.entry.toolStatus === "completed" ||
      entry.entry.toolStatus === "failed" ||
      entry.entry.toolStatus === "declined"
    ) {
      setCurrent({
        label: "Thinking",
        startedAt: entry.entry.updatedAt ?? entry.entry.createdAt,
      });
    }
  }

  return current ?? { label: input.fallbackLabel ?? "Thinking", startedAt: firstOutputAt };
}

function isActiveWorkWindowEntry(input: {
  activeTurnId: TurnId | null;
  startedAt: string | null;
  turnId: TurnId | null | undefined;
  createdAt: string;
}): boolean {
  if (input.activeTurnId) {
    return input.turnId === input.activeTurnId;
  }
  if (input.startedAt && input.createdAt.localeCompare(input.startedAt) < 0) {
    return false;
  }
  return true;
}

function firstActiveTurnOutputAt(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  activeTurnId: TurnId | null;
  startedAt: string | null;
}): string | null {
  let firstOutputAt: string | null = null;
  const collect = (createdAt: string) => {
    if (!input.activeTurnId && input.startedAt && createdAt.localeCompare(input.startedAt) < 0) {
      return;
    }
    if (!firstOutputAt || createdAt.localeCompare(firstOutputAt) < 0) {
      firstOutputAt = createdAt;
    }
  };

  for (const entry of input.timelineEntries) {
    if (entry.kind === "message") {
      if (
        entry.message.role === "assistant" &&
        isActiveWorkWindowEntry({
          activeTurnId: input.activeTurnId,
          startedAt: input.startedAt,
          turnId: entry.message.turnId,
          createdAt: entry.message.createdAt,
        })
      ) {
        collect(entry.message.createdAt);
      }
      continue;
    }

    if (
      entry.kind === "work" &&
      isActiveWorkWindowEntry({
        activeTurnId: input.activeTurnId,
        startedAt: input.startedAt,
        turnId: entry.entry.turnId,
        createdAt: entry.entry.createdAt,
      })
    ) {
      collect(entry.entry.createdAt);
    }
  }
  return firstOutputAt;
}

function earliestWorkEntryStart(entries: ReadonlyArray<WorkLogEntry>): string | null {
  let earliest: string | null = null;
  for (const entry of entries) {
    if (!earliest || entry.createdAt.localeCompare(earliest) < 0) {
      earliest = entry.createdAt;
    }
  }
  return earliest;
}

function workingToolPhaseLabel(entry: WorkLogEntry): string {
  if (entry.requestKind === "command") return "Awaiting command approval";
  if (entry.requestKind === "file-read") return "Awaiting file-read approval";
  if (entry.requestKind === "file-change") return "Awaiting file-change approval";
  if (entry.command) return "Running command";

  if (entry.itemType) {
    switch (entry.itemType) {
      case "command_execution":
        return "Running command";
      case "file_change":
        return "Editing files";
      case "mcp_tool_call":
        return "Using MCP tool";
      case "dynamic_tool_call":
        return "Using tool";
      case "collab_agent_tool_call":
        return "Waiting for subagent";
      case "web_search":
        return "Searching web";
      case "image_view":
        return "Viewing image";
      default: {
        return entry.itemType satisfies never;
      }
    }
  }

  const label = entry.label.trim();
  if (label.length > 0 && !isGenericWorkingToolLabel(label)) {
    return label;
  }
  return "Awaiting tool call";
}

function workingThinkingPhaseLabel(entry: WorkLogEntry): string | null {
  const label = entry.label.trim();
  if (!label || isGenericThinkingLabel(label)) {
    return null;
  }
  return label;
}

function isGenericWorkingToolLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  return (
    normalized === "tool" ||
    normalized === "tool started" ||
    normalized === "tool updated" ||
    normalized === "tool call" ||
    normalized === "dynamic tool call" ||
    normalized === "mcp tool call"
  );
}

function isGenericThinkingLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  return normalized === "thinking" || normalized === "task progress" || normalized === "working";
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

/** Shallow field comparison per row variant — avoids deep equality cost. */
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "working":
      return (
        a.createdAt === (b as typeof a).createdAt &&
        a.phaseLabel === (b as typeof a).phaseLabel &&
        a.phaseStartedAt === (b as typeof a).phaseStartedAt &&
        a.totalStartedAt === (b as typeof a).totalStartedAt
      );

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "work":
      return Equal.equals(a.groupedEntries, (b as typeof a).groupedEntries);

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.durationStart === bm.durationStart &&
        a.showCompletionDivider === bm.showCompletionDivider &&
        a.completionSummary === bm.completionSummary &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount
      );
    }
  }
}
