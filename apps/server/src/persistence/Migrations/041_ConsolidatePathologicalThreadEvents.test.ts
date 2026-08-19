import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_ConsolidatePathologicalThreadEvents", (it) => {
  it.effect("consolidates pathological assistant and tool chunk histories", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 40 });

      yield* sql`
        WITH RECURSIVE chunks(n) AS (
          SELECT 1
          UNION ALL
          SELECT n + 1 FROM chunks WHERE n < 1000
        )
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        )
        SELECT
          printf('assistant-event-%d', n),
          'thread',
          'thread-huge',
          n,
          'thread.message-sent',
          '2026-08-19T00:00:00.000Z',
          printf('assistant-command-%d', n),
          NULL,
          NULL,
          'system',
          json_object(
            'threadId', 'thread-huge',
            'messageId', 'assistant-huge',
            'role', 'assistant',
            'text', 'x',
            'turnId', 'turn-huge',
            'streaming', json('true'),
            'createdAt', '2026-08-19T00:00:00.000Z',
            'updatedAt', '2026-08-19T00:00:00.000Z'
          ),
          '{}'
        FROM chunks
      `;

      yield* sql`
        WITH RECURSIVE chunks(n) AS (
          SELECT 1
          UNION ALL
          SELECT n + 1 FROM chunks WHERE n < 1000
        )
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        )
        SELECT
          printf('tool-event-%d', n),
          'thread',
          'thread-huge',
          1000 + n,
          'thread.activity-appended',
          '2026-08-19T00:00:00.000Z',
          printf('tool-command-%d', n),
          NULL,
          NULL,
          'system',
          json_object(
            'threadId', 'thread-huge',
            'activity', json_object(
              'id', printf('tool-event-%d', n),
              'tone', 'tool',
              'kind', 'tool.updated',
              'summary', 'Command output',
              'payload', json_object(
                'itemId', 'tool-huge',
                'itemType', 'command_execution',
                'status', 'inProgress',
                'data', json_object('rawOutput', json_object('stdout', 'y'))
              ),
              'turnId', 'turn-huge',
              'createdAt', '2026-08-19T00:00:00.000Z'
            )
          ),
          '{}'
        FROM chunks
      `;

      yield* sql`
        WITH RECURSIVE chunks(n) AS (
          SELECT 1
          UNION ALL
          SELECT n + 1 FROM chunks WHERE n < 1000
        )
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary,
          payload_json, sequence, created_at
        )
        SELECT
          printf('tool-event-%d', n),
          'thread-huge',
          'turn-huge',
          'tool',
          'tool.updated',
          'Command output',
          json_object(
            'itemId', 'tool-huge',
            'itemType', 'command_execution',
            'status', 'inProgress',
            'data', json_object('rawOutput', json_object('stdout', 'y'))
          ),
          1000 + n,
          '2026-08-19T00:00:00.000Z'
        FROM chunks
      `;

      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        ) VALUES
          (
            'small-event-1', 'thread', 'thread-small', 1, 'thread.message-sent',
            '2026-08-19T00:00:00.000Z', NULL, NULL, NULL, 'system',
            '{"threadId":"thread-small","messageId":"assistant-small","role":"assistant","text":"a","turnId":"turn-small","streaming":true,"createdAt":"2026-08-19T00:00:00.000Z","updatedAt":"2026-08-19T00:00:00.000Z"}',
            '{}'
          ),
          (
            'small-event-2', 'thread', 'thread-small', 2, 'thread.message-sent',
            '2026-08-19T00:00:00.000Z', NULL, NULL, NULL, 'system',
            '{"threadId":"thread-small","messageId":"assistant-small","role":"assistant","text":"b","turnId":"turn-small","streaming":true,"createdAt":"2026-08-19T00:00:00.000Z","updatedAt":"2026-08-19T00:00:00.000Z"}',
            '{}'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 41 });

      const eventCounts = yield* sql<{
        readonly assistantCount: number;
        readonly toolCount: number;
        readonly smallCount: number;
      }>`
        SELECT
          SUM(stream_id = 'thread-huge' AND event_type = 'thread.message-sent') AS "assistantCount",
          SUM(stream_id = 'thread-huge' AND event_type = 'thread.activity-appended') AS "toolCount",
          SUM(stream_id = 'thread-small') AS "smallCount"
        FROM orchestration_events
      `;
      assert.deepStrictEqual(eventCounts, [{ assistantCount: 1, toolCount: 1, smallCount: 2 }]);

      const consolidated = yield* sql<{
        readonly assistantLength: number;
        readonly toolLength: number;
        readonly projectedToolLength: number;
      }>`
        SELECT
          (SELECT length(json_extract(payload_json, '$.text'))
            FROM orchestration_events
            WHERE event_id = 'assistant-event-1000') AS "assistantLength",
          (SELECT length(json_extract(payload_json, '$.activity.payload.data.rawOutput.stdout'))
            FROM orchestration_events
            WHERE event_id = 'tool-event-1000') AS "toolLength",
          (SELECT length(json_extract(payload_json, '$.data.rawOutput.stdout'))
            FROM projection_thread_activities
            WHERE activity_id = 'tool-event-1000') AS "projectedToolLength"
      `;
      assert.deepStrictEqual(consolidated, [
        { assistantLength: 1000, toolLength: 1000, projectedToolLength: 1000 },
      ]);
    }),
  );
});
