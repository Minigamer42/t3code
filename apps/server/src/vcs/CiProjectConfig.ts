import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, PositiveInt } from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";

const Command = Schema.TupleWithRest(Schema.Tuple([TrimmedNonEmptyString]), [Schema.String]);
export const CiProjectConfig = Schema.Struct({
  recovery: Schema.optional(
    Schema.Record(
      TrimmedNonEmptyString,
      Schema.Struct({
        jobs: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
        match: Command,
        action: Schema.Union([
          Schema.Struct({ type: Schema.Literal("retry-job") }),
          Schema.Struct({ type: Schema.Literal("play-job"), name: TrimmedNonEmptyString }),
        ]),
        maxAttempts: PositiveInt,
      }),
    ),
  ),
  onUnresolvedFailure: Schema.optional(
    Schema.Struct({
      action: Schema.Literal("resume-originating-thread"),
      instructions: TrimmedNonEmptyString,
    }),
  ),
});
export type CiProjectConfig = typeof CiProjectConfig.Type;
const decode = Schema.decodeUnknownEffect(fromLenientJson(CiProjectConfig));
export const read = Effect.fn("CiProjectConfig.read")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let directory = cwd;
  while (true) {
    const filename = path.join(directory, ".t3code", "ci.json");
    if (yield* fs.exists(filename))
      return { config: yield* decode(yield* fs.readFileString(filename)), directory };
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
});
