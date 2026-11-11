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

it.effect.each([
  { count: 3, omitted: false, invalidIndex: false },
  { count: 61, omitted: false, invalidIndex: false },
  { count: 61, omitted: true, invalidIndex: false },
  { count: 3, omitted: false, invalidIndex: true },
])(
  "assigns every change unit through the provider runner: $count / omitted $omitted / invalid $invalidIndex",
  ({ count, omitted, invalidIndex }) =>
    Effect.gen(function* () {
      const ids = Array.from(
        { length: count },
        (_, index) => `H${String(index + 1).padStart(3, "0")}`,
      );
      const assignments = Object.fromEntries(
        ids
          .filter((id) => !omitted || !["H052", "H060", "H061"].includes(id))
          .map((id, index) => [id, invalidIndex ? 2 : index === 0 ? 0 : 1]),
      );
      const generation = fromRunner("Test", (request) =>
        decodeJsonReply(
          request,
          "Test",
          JSON.stringify({
            commits: [
              { subject: " Add schema.\nExtra prose", body: "  Foundation  " },
              { subject: "Use schema", body: "" },
            ],
            assignments,
          }),
        ),
      );
      const operation = generation.generateCommitPlan({
        cwd: "/repo",
        branch: "feature/schema",
        changeUnitSummary: ids
          .map((id, index) => `${id}\tsrc/test/resources/case-${index}.php.txt\twhole-file change`)
          .join("\n"),
        annotatedPatch: ids.map((id) => `### ${id}\n+fixture`).join("\n"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
      });
      if (omitted || invalidIndex) {
        const error = yield* operation.pipe(Effect.flip);
        expect(error._tag).toBe("TextGenerationError");
        if (invalidIndex) expect(error.message).toContain("missing commit index 2");
      } else {
        expect(yield* operation).toEqual({
          commits: [
            { subject: "Add schema", body: "Foundation", hunkIds: [ids[0]] },
            { subject: "Use schema", body: "", hunkIds: ids.slice(1) },
          ],
        });
      }
    }),
);
