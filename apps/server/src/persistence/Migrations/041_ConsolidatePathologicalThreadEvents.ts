import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const PATHOLOGICAL_STREAM_EVENT_COUNT = 1_000;

interface EventRow {
  readonly sequence: number;
  readonly eventId: string;
  readonly streamId: string;
  readonly eventType: string;
  readonly payloadJson: string;
}

interface CompactionGroup {
  readonly kind: "assistant" | "tool";
  readonly streamId: string;
  readonly groupId: string;
  readonly keepSequence: number;
  readonly keepEventId: string;
  readonly payloadJson: string;
  readonly projectionPayloadJson?: string;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<EventRow>`
    SELECT
      sequence,
      event_id AS "eventId",
      stream_id AS "streamId",
      event_type AS "eventType",
      payload_json AS "payloadJson"
    FROM orchestration_events
    WHERE aggregate_kind = 'thread'
      AND stream_id IN (
        SELECT stream_id
        FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND (
            (event_type = 'thread.message-sent'
              AND json_extract(payload_json, '$.role') = 'assistant'
              AND json_extract(payload_json, '$.streaming') = 1)
            OR
            (event_type = 'thread.activity-appended'
              AND json_extract(payload_json, '$.activity.kind') = 'tool.updated'
              AND json_extract(payload_json, '$.activity.summary') IN (
                'Command output',
                'File change output'
              ))
          )
        GROUP BY stream_id
        HAVING COUNT(*) >= ${PATHOLOGICAL_STREAM_EVENT_COUNT}
      )
      AND (
        (event_type = 'thread.message-sent'
          AND json_extract(payload_json, '$.role') = 'assistant'
          AND json_extract(payload_json, '$.streaming') = 1)
        OR
        (event_type = 'thread.activity-appended'
          AND json_extract(payload_json, '$.activity.kind') = 'tool.updated'
          AND json_extract(payload_json, '$.activity.summary') IN (
            'Command output',
            'File change output'
          ))
      )
    ORDER BY sequence
  `;

  const grouped = new Map<
    string,
    Array<EventRow & { readonly payload: Record<string, unknown> }>
  >();
  for (const row of rows) {
    const decoded = decodeJson(row.payloadJson);
    if (Option.isNone(decoded)) continue;
    const payload = record(decoded.value);
    if (!payload) continue;
    const groupId =
      row.eventType === "thread.message-sent"
        ? payload.messageId
        : record(payload.activity)?.payload
          ? record(record(payload.activity)?.payload)?.itemId
          : undefined;
    if (typeof groupId !== "string" || groupId.length === 0) continue;
    const kind = row.eventType === "thread.message-sent" ? "assistant" : "tool";
    const key = `${kind}:${row.streamId}:${groupId}`;
    const current = grouped.get(key) ?? [];
    current.push({ ...row, payload });
    grouped.set(key, current);
  }

  const groups: CompactionGroup[] = [];
  for (const entries of grouped.values()) {
    if (entries.length < 2) continue;
    const last = entries.at(-1)!;
    if (last.eventType === "thread.message-sent") {
      const text = entries
        .map((entry) => entry.payload.text)
        .filter((value): value is string => typeof value === "string")
        .join("");
      groups.push({
        kind: "assistant",
        streamId: last.streamId,
        groupId: String(last.payload.messageId),
        keepSequence: last.sequence,
        keepEventId: last.eventId,
        payloadJson: encodeJson({ ...last.payload, text }),
      });
      continue;
    }

    const lastActivity = record(last.payload.activity);
    const lastActivityPayload = record(lastActivity?.payload);
    if (!lastActivity || !lastActivityPayload) continue;
    const itemType = lastActivityPayload.itemType;
    const field = itemType === "file_change" ? "content" : "stdout";
    const text = entries
      .map((entry) => {
        const activityPayload = record(record(entry.payload.activity)?.payload);
        const data = record(activityPayload?.data);
        const rawOutput = record(data?.rawOutput);
        return rawOutput?.[field];
      })
      .filter((value): value is string => typeof value === "string")
      .join("");
    const data = record(lastActivityPayload.data) ?? {};
    const rawOutput = record(data.rawOutput) ?? {};
    const projectionPayload = {
      ...lastActivityPayload,
      data: { ...data, rawOutput: { ...rawOutput, [field]: text } },
    };
    const activity = { ...lastActivity, payload: projectionPayload };
    groups.push({
      kind: "tool",
      streamId: last.streamId,
      groupId: String(lastActivityPayload.itemId),
      keepSequence: last.sequence,
      keepEventId: last.eventId,
      payloadJson: encodeJson({ ...last.payload, activity }),
      projectionPayloadJson: encodeJson(projectionPayload),
    });
  }

  yield* sql`
    CREATE TEMP TABLE IF NOT EXISTS orchestration_event_compaction_groups (
      kind TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      keep_sequence INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (kind, stream_id, group_id)
    )
  `;
  yield* sql`DELETE FROM orchestration_event_compaction_groups`;
  yield* Effect.forEach(
    groups,
    (group) =>
      sql`
        INSERT INTO orchestration_event_compaction_groups (
          kind, stream_id, group_id, keep_sequence, payload_json
        ) VALUES (
          ${group.kind}, ${group.streamId}, ${group.groupId},
          ${group.keepSequence}, ${group.payloadJson}
        )
      `,
    { concurrency: 1, discard: true },
  );

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = (
      SELECT compact.payload_json
      FROM orchestration_event_compaction_groups AS compact
      WHERE compact.keep_sequence = orchestration_events.sequence
    )
    WHERE sequence IN (
      SELECT keep_sequence FROM orchestration_event_compaction_groups
    )
  `;

  yield* Effect.forEach(
    groups.filter((group) => group.kind === "tool"),
    (group) =>
      Effect.gen(function* () {
        yield* sql`
          UPDATE projection_thread_activities
          SET payload_json = ${group.projectionPayloadJson!}
          WHERE activity_id = ${group.keepEventId}
        `;
        yield* sql`
          DELETE FROM projection_thread_activities
          WHERE thread_id = ${group.streamId}
            AND kind = 'tool.updated'
            AND activity_id <> ${group.keepEventId}
            AND json_extract(payload_json, '$.itemId') = ${group.groupId}
            AND summary IN ('Command output', 'File change output')
        `;
      }),
    { concurrency: 1, discard: true },
  );

  yield* sql`
    DELETE FROM orchestration_events AS event
    WHERE EXISTS (
      SELECT 1
      FROM orchestration_event_compaction_groups AS compact
      WHERE compact.stream_id = event.stream_id
        AND event.sequence <> compact.keep_sequence
        AND (
          (compact.kind = 'assistant'
            AND event.event_type = 'thread.message-sent'
            AND json_extract(event.payload_json, '$.role') = 'assistant'
            AND json_extract(event.payload_json, '$.streaming') = 1
            AND json_extract(event.payload_json, '$.messageId') = compact.group_id)
          OR
          (compact.kind = 'tool'
            AND event.event_type = 'thread.activity-appended'
            AND json_extract(event.payload_json, '$.activity.kind') = 'tool.updated'
            AND json_extract(event.payload_json, '$.activity.payload.itemId') = compact.group_id
            AND json_extract(event.payload_json, '$.activity.summary') IN (
              'Command output',
              'File change output'
            ))
        )
    )
  `;

  yield* sql`DROP TABLE orchestration_event_compaction_groups`;
});
