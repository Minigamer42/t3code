import type { OrchestrationV2Run, OrchestrationV2TurnItem } from "./orchestrationV2.ts";

export const SCHEDULED_NO_UPDATE_RESPONSE = "NO_UPDATE";

/** An exact final response silences a terminal run regardless of its earlier activity. */
export function scheduledNoUpdateRunIds(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status" | "providerThreadId">>,
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlySet<OrchestrationV2Run["id"]> {
  const ended = new Map(
    runs
      .filter(
        (run) =>
          run.status === "completed" ||
          run.status === "failed" ||
          run.status === "interrupted" ||
          run.status === "cancelled",
      )
      .map((run) => [run.id, run]),
  );
  const lastResponse = new Map<
    OrchestrationV2Run["id"],
    Extract<OrchestrationV2TurnItem, { type: "assistant_message" }>
  >();
  for (const item of items) {
    const runId = item.runId;
    if (runId === null || !ended.has(runId)) continue;
    if (
      item.type === "assistant_message" &&
      item.parentItemId === null &&
      item.providerThreadId === ended.get(runId)?.providerThreadId &&
      (item.phase === undefined || item.phase === "final_answer")
    ) {
      const previous = lastResponse.get(runId);
      if (previous === undefined || item.ordinal > previous.ordinal) lastResponse.set(runId, item);
    }
  }
  return new Set(
    [...ended.keys()].filter((id) => {
      const response = lastResponse.get(id);
      return (
        response !== undefined &&
        !response.streaming &&
        response.text.trim() === SCHEDULED_NO_UPDATE_RESPONSE
      );
    }),
  );
}
