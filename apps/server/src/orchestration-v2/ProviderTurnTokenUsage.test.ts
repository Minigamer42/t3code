import {
  NodeId,
  type OrchestrationV2ProviderTurn,
  ProviderThreadId,
  ProviderTurnId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { upsertProviderTurn } from "./ProjectionStore.ts";

describe("provider turn token usage projection", () => {
  it("keeps live usage when a terminal update omits it", () => {
    const now = DateTime.makeUnsafe("2026-08-29T00:00:00.000Z");
    const running = {
      id: ProviderTurnId.make("provider-turn-usage"),
      providerThreadId: ProviderThreadId.make("provider-thread-usage"),
      nodeId: NodeId.make("node-usage"),
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: 1,
      status: "running",
      startedAt: now,
      completedAt: null,
      tokenUsage: {
        usedTokens: 50_000,
        maxTokens: 200_000,
        updatedAt: "2026-08-29T00:00:00.000Z",
      },
    } satisfies OrchestrationV2ProviderTurn;
    const completed = {
      ...running,
      status: "completed",
      completedAt: now,
      tokenUsage: undefined,
    } satisfies OrchestrationV2ProviderTurn;

    const projected = upsertProviderTurn([running], completed);

    assert.deepEqual(projected[0]?.tokenUsage, running.tokenUsage);
    assert.equal(projected[0]?.status, "completed");
  });

  it("preserves recorded generation speed through later provider updates", () => {
    const now = DateTime.makeUnsafe("2026-10-14T00:00:00.000Z");
    const measured: OrchestrationV2ProviderTurn = {
      id: ProviderTurnId.make("measured-turn"),
      providerThreadId: ProviderThreadId.make("measured-thread"),
      nodeId: NodeId.make("measured-node"),
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: 1,
      status: "completed",
      startedAt: now,
      completedAt: now,
      generationSpeed: {
        provider: "codex",
        model: "gpt-6.1",
        startedAt: "2026-10-14T00:00:00.000Z",
        outputTokens: 100,
        durationMs: 2_000,
        responses: 1,
      },
    };
    const next = upsertProviderTurn([measured], { ...measured, generationSpeed: undefined });
    assert.deepEqual(next[0]?.generationSpeed, measured.generationSpeed);
  });
});
