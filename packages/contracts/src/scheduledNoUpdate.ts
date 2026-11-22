import type { OrchestrationV2Run, OrchestrationV2TurnItem } from "./orchestrationV2.ts";

export const SCHEDULED_NO_UPDATE_RESPONSE = "NO_UPDATE";

/** Only an explicit final response can silence a successful scheduled run. */
export function scheduledNoUpdateRunIds(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status" | "providerThreadId">>,
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlySet<OrchestrationV2Run["id"]> {
  const completed = new Map(
    runs.filter((run) => run.status === "completed").map((run) => [run.id, run]),
  );
  const scheduled = new Set<OrchestrationV2Run["id"]>();
  const blocked = new Set<OrchestrationV2Run["id"]>();
  const lastResponse = new Map<
    OrchestrationV2Run["id"],
    Extract<OrchestrationV2TurnItem, { type: "assistant_message" }>
  >();
  for (const item of items) {
    const runId = item.runId;
    if (runId === null || !completed.has(runId)) continue;
    if (item.type === "user_message") {
      if (item.scheduledTaskId !== undefined) scheduled.add(runId);
      else blocked.add(runId);
    }
    if (
      item.type === "error" ||
      item.type === "user_input_request" ||
      item.type === "secret_request" ||
      item.type === "link_request" ||
      item.type === "approval_request" ||
      item.type === "file_change" ||
      item.status === "failed" ||
      item.status === "waiting" ||
      item.status === "running" ||
      item.status === "pending"
    )
      blocked.add(runId);
    if (
      item.type === "assistant_message" &&
      item.parentItemId === null &&
      item.providerThreadId === completed.get(runId)?.providerThreadId &&
      (item.phase === undefined || item.phase === "final_answer")
    ) {
      const previous = lastResponse.get(runId);
      if (previous === undefined || item.ordinal > previous.ordinal) lastResponse.set(runId, item);
    }
  }
  return new Set(
    [...scheduled].filter((id) => {
      const response = lastResponse.get(id);
      return (
        !blocked.has(id) &&
        response !== undefined &&
        !response.streaming &&
        (response.attachments?.length ?? 0) === 0 &&
        response.text.trim() === SCHEDULED_NO_UPDATE_RESPONSE
      );
    }),
  );
}
