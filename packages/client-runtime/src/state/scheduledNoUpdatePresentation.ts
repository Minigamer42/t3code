import {
  scheduledNoUpdateRunIds,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2Run,
} from "@t3tools/contracts";

const collapsedGroups = new WeakMap<
  OrchestrationV2ProjectedTurnItem,
  {
    rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
    summary: OrchestrationV2ProjectedTurnItem;
  }
>();

/** Keep the original rows in the projection; a normal expandable work row holds their audit. */
export function collapseScheduledNoUpdates(
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  runs: ReadonlyArray<OrchestrationV2Run>,
): ReadonlyArray<OrchestrationV2ProjectedTurnItem> {
  const quiet = scheduledNoUpdateRunIds(
    runs,
    rows.map((row) => row.item),
  );
  if (quiet.size === 0) return rows;
  const result: OrchestrationV2ProjectedTurnItem[] = [];
  let group: OrchestrationV2ProjectedTurnItem[] = [];
  const flush = () => {
    const first = group[0];
    if (first === undefined) return;
    const cached = collapsedGroups.get(first);
    if (
      cached !== undefined &&
      cached.rows.length === group.length &&
      cached.rows.every((row, index) => row === group[index])
    ) {
      result.push(cached.summary);
      group = [];
      return;
    }
    const count = new Set(group.map((row) => row.item.runId)).size;
    const last = group.at(-1)!.item;
    const { item } = first;
    const summary: OrchestrationV2ProjectedTurnItem = {
      ...first,
      visibility: "synthetic",
      item: {
        id: item.id,
        threadId: item.threadId,
        runId: item.runId,
        nodeId: item.nodeId,
        providerThreadId: item.providerThreadId ?? null,
        providerTurnId: item.providerTurnId ?? null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: item.ordinal,
        type: "dynamic_tool",
        status: "completed",
        title: `${count} ${count === 1 ? "check" : "checks"} · no updates`,
        startedAt: item.startedAt,
        completedAt: last.completedAt,
        updatedAt: last.updatedAt,
        toolName: null,
        input: null,
        output: { history: group.map((row) => row.item) },
      },
    };
    collapsedGroups.set(first, { rows: group, summary });
    result.push(summary);
    group = [];
  };
  for (const row of rows) {
    if (row.item.runId !== null && quiet.has(row.item.runId)) group.push(row);
    else {
      flush();
      result.push(row);
    }
  }
  flush();
  return result;
}
