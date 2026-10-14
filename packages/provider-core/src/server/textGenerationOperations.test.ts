import { assert, expect, it } from "@effect/vitest";
import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decodeJsonReply, fromRunner } from "./textGenerationOperations.ts";

// regression: #23726 a reply that echoes the schema key replaced the seed title with "title"
it.effect("fails a thread title reply that is only the schema key", () =>
  Effect.gen(function* () {
    const textGeneration = fromRunner("Stub", (request) =>
      decodeJsonReply(request, "Stub", '{"title":"title","needsRefinement":false}'),
    );

    const outcome = yield* textGeneration
      .generateThreadTitle({
        cwd: process.cwd(),
        message: "$implement Issue #140",
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: "anthropic/claude-haiku-4-5",
        },
      })
      .pipe(Effect.match({ onFailure: (error) => error, onSuccess: (result) => result }));

    assert.instanceOf(outcome, TextGenerationError);
    assert.strictEqual(outcome.operation, "generateThreadTitle");
  }),
);

it.effect("returns an ordered split commit plan through the shared provider runner", () =>
  Effect.gen(function* () {
    const generation = fromRunner("Test", (request) =>
      decodeJsonReply(
        request,
        "Test",
        JSON.stringify({
          commits: [
            { subject: " Add schema.\nExtra prose", body: "  Foundation  ", hunkIds: [" h1 "] },
            { subject: "Use schema", body: "", hunkIds: ["h2", "h3"] },
          ],
        }),
      ),
    );
    const plan = yield* generation.generateCommitPlan({
      cwd: "/repo",
      branch: "feature/schema",
      changeUnitSummary: "h1 schema; h2 implementation; h3 tests",
      annotatedPatch: "h1 +schema\nh2 +implementation\nh3 +tests",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    });
    expect(plan).toEqual({
      commits: [
        { subject: "Add schema", body: "Foundation", hunkIds: ["h1"] },
        { subject: "Use schema", body: "", hunkIds: ["h2", "h3"] },
      ],
    });
  }),
);
