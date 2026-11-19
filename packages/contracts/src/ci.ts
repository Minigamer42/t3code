import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

export const CiJob = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.String,
  url: Schema.NullOr(Schema.String),
  allowFailure: Schema.Boolean,
});
export type CiJob = typeof CiJob.Type;
export const CiPipeline = Schema.Struct({
  id: Schema.String,
  sha: Schema.String,
  status: Schema.String,
  url: Schema.String,
  jobs: Schema.Array(CiJob),
});
export type CiPipeline = typeof CiPipeline.Type;
export const CiActivity = Schema.Struct({
  id: Schema.String,
  cwd: Schema.String,
  host: Schema.String,
  repository: Schema.String,
  branch: Schema.String,
  localBranch: Schema.String,
  sha: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  state: Schema.Literals([
    "waiting",
    "running",
    "recovering",
    "passed",
    "failed",
    "superseded",
    "cancelled",
    "skipped",
  ]),
  label: Schema.String,
  startedAt: Schema.Number,
  updatedAt: Schema.Number,
  pipeline: Schema.NullOr(CiPipeline),
  attempts: Schema.Record(Schema.String, Schema.Number),
});
export type CiActivity = typeof CiActivity.Type;
