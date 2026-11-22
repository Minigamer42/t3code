import { describe, expect, it } from "@effect/vitest";
import {
  NodeId,
  MessageId,
  RunId,
  ScheduledTaskId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import { v2Now, v2ThreadId, v2Projection } from "./orchestrationV2TestFixtures.ts";
import { collapseScheduledNoUpdates } from "./scheduledNoUpdatePresentation.ts";

function fixture(id: string, text = "NO_UPDATE") {
  const run: OrchestrationV2Run = {
    id: RunId.make(id),
    threadId: v2ThreadId,
    ordinal: 1,
    providerInstanceId: v2Projection.thread.providerInstanceId,
    modelSelection: v2Projection.thread.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`${id}-prompt`),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt: v2Now,
    startedAt: v2Now,
    completedAt: v2Now,
    checkpointId: null,
    contextHandoffId: null,
  };
  const base = {
    threadId: v2ThreadId,
    runId: run.id,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: v2Now,
    completedAt: v2Now,
    updatedAt: v2Now,
  } as const;
  const prompt: OrchestrationV2TurnItem = {
    ...base,
    id: TurnItemId.make(`${id}-prompt`),
    type: "user_message",
    messageId: run.userMessageId,
    scheduledTaskId: ScheduledTaskId.make("task"),
    createdBy: "agent",
    creationSource: "server",
    inputIntent: "turn_start",
    text: "Check the queue",
    attachments: [],
  };
  const response: OrchestrationV2TurnItem = {
    ...base,
    ordinal: 2,
    id: TurnItemId.make(`${id}-response`),
    type: "assistant_message",
    nodeId: NodeId.make(`${id}-native-message`),
    phase: "final_answer",
    messageId: MessageId.make(`${id}-response`),
    text,
    streaming: false,
  };
  const row = (item: OrchestrationV2TurnItem): OrchestrationV2ProjectedTurnItem => ({
    position: item.ordinal,
    visibility: "local",
    sourceThreadId: v2ThreadId,
    sourceItemId: item.id,
    item,
  });
  return { run, rows: [row(prompt), row(response)], row, base };
}

describe("scheduled no-update presentation", () => {
  it("collapses consecutive quiet checks, retains their audit and reuses the summary", () => {
    const a = fixture("a");
    const b = fixture("b");
    const c = fixture("c", "Started the next ticket.");
    const rows = [...a.rows, ...b.rows, ...c.rows];
    const runs = [a.run, b.run, c.run];
    const result = collapseScheduledNoUpdates(rows, runs);
    expect(result).toHaveLength(3);
    expect(result[0]?.item).toMatchObject({
      type: "dynamic_tool",
      title: "2 checks · no updates",
    });
    expect(result[0]?.item.type === "dynamic_tool" && result[0].item.output).toEqual({
      history: [...a.rows, ...b.rows].map((row) => row.item),
    });
    expect(result.slice(1)).toEqual(c.rows);
    expect(collapseScheduledNoUpdates([...rows], [...runs])[0]).toBe(result[0]);
    expect(rows).toHaveLength(6);
  });

  it.each(["running", "failed", "interrupted", "waiting"] as const)(
    "keeps %s checks visible",
    (status) => {
      const { run, rows } = fixture("a");
      expect(collapseScheduledNoUpdates(rows, [{ ...run, status }])).toBe(rows);
    },
  );

  it("requires an explicit root final, a scheduled prompt and no requests or errors", () => {
    for (const text of ["", "Nothing changed", "`NO_UPDATE`", "NO_UPDATE\nThere is a blocker."]) {
      const { rows, run } = fixture("a", text);
      expect(collapseScheduledNoUpdates(rows, [run])).toBe(rows);
    }
    const { rows, run, row, base } = fixture("a");
    const prompt = rows[0]!.item;
    if (prompt.type !== "user_message") throw new Error("fixture");
    const { scheduledTaskId: _task, ...manual } = prompt;
    const manualRows = [row(manual), rows[1]!];
    expect(collapseScheduledNoUpdates(manualRows, [run])).toBe(manualRows);
    const guarded = [
      ...rows,
      row({
        ...base,
        ordinal: 3,
        id: TurnItemId.make("error"),
        type: "error",
        status: "failed",
        failure: { class: "unknown", code: null, message: "Failed", retryable: false },
      }),
    ];
    expect(collapseScheduledNoUpdates(guarded, [run])).toBe(guarded);
    const response = rows[1]!.item;
    if (response.type !== "assistant_message") throw new Error("fixture");
    for (const changed of [
      { ...response, phase: "commentary" as const },
      { ...response, phase: "partial_answer" as const },
      { ...response, streaming: true },
      { ...response, parentItemId: prompt.id },
    ]) {
      const altered = [rows[0]!, row(changed)];
      expect(collapseScheduledNoUpdates(altered, [run])).toBe(altered);
    }
  });
});
