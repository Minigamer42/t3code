import { GitManagerError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import type {
  GitWorkflowProgress,
  GitWorkflowProgressUpdate,
  GitWorkflowStep,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

export type ProgressReporter = (update: GitWorkflowProgressUpdate) => Effect.Effect<void>;

export function reportSteps(
  report: ProgressReporter | undefined,
  initial: readonly GitWorkflowStep[],
) {
  let steps = initial;
  return Effect.fn("WorkflowProgress.steps")(function* (
    label: string,
    update: (steps: readonly GitWorkflowStep[]) => readonly GitWorkflowStep[] = (steps) => steps,
  ) {
    steps = update(steps);
    if (report) yield* report({ label, steps });
  });
}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const entries = new Map<
    string,
    {
      ref: SubscriptionRef.SubscriptionRef<GitWorkflowProgress | null>;
      readers: number;
      active: boolean;
      activity?: NonNullable<GitWorkflowProgress["activity"]>;
    }
  >();
  const entry = Effect.fn("WorkflowProgress.entry")(function* (cwd: string) {
    const key = yield* fs.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
    const previous = entries.get(key);
    if (previous) return previous;
    const created: {
      ref: SubscriptionRef.SubscriptionRef<GitWorkflowProgress | null>;
      readers: number;
      active: boolean;
      activity?: NonNullable<GitWorkflowProgress["activity"]>;
    } = {
      ref: yield* SubscriptionRef.make<GitWorkflowProgress | null>(null),
      readers: 0,
      active: false,
    };
    const current = entries.get(key) ?? created;
    entries.set(key, current);
    for (const [name, value] of entries) {
      if (entries.size <= 256) break;
      if (name !== key && value.readers === 0 && !value.active && !value.activity)
        entries.delete(name);
    }
    return current;
  });
  const run = Effect.fn("WorkflowProgress.run")(function* <A, E, R>(
    cwd: string,
    kind: GitWorkflowProgress["kind"],
    label: string,
    action: (report: ProgressReporter) => Effect.Effect<A, E, R>,
  ) {
    const owner = yield* entry(cwd);
    owner.active = true;
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const startedAtMs = yield* Clock.currentTimeMillis;
        if (owner.activity) owner.activity = { ...owner.activity, label };
        yield* SubscriptionRef.set(owner.ref, {
          kind,
          ...(owner.activity ? { activity: owner.activity } : {}),
          state: "running",
          startedAtMs,
          label,
          steps: [],
        });
        const report: ProgressReporter = (update) => {
          if (owner.activity) owner.activity = { ...owner.activity, label: update.label };
          const snapshot: GitWorkflowProgress = {
            ...update,
            kind,
            state: "running",
            startedAtMs,
            ...(owner.activity ? { activity: owner.activity } : {}),
          };
          return SubscriptionRef.set(owner.ref, snapshot);
        };
        const finish = (state: GitWorkflowProgress["state"]) =>
          SubscriptionRef.update(owner.ref, (current): GitWorkflowProgress | null =>
            current
              ? {
                  ...current,
                  state: owner.activity ? "running" : state,
                  label:
                    state === "completed"
                      ? kind === "stack"
                        ? "Stack updated"
                        : "Logical commits created"
                      : state === "cancelled"
                        ? "Workflow cancelled"
                        : "Workflow stopped",
                  steps: current.steps.map((step): GitWorkflowStep =>
                    step.state === "running"
                      ? {
                          ...step,
                          state:
                            state === "completed"
                              ? "completed"
                              : state === "cancelled"
                                ? "skipped"
                                : "failed",
                        }
                      : step,
                  ),
                }
              : null,
          );
        return yield* restore(action(report)).pipe(
          Effect.tap(() => finish("completed")),
          Effect.onError((cause) =>
            finish(Cause.hasInterruptsOnly(cause) ? "cancelled" : "failed"),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              owner.active = false;
            }),
          ),
        );
      }),
    );
  });
  const withActivity = Effect.fn("WorkflowProgress.withActivity")(function* <A, E, R>(
    cwd: string,
    label: string,
    action: (report: (label: string) => Effect.Effect<void>) => Effect.Effect<A, E, R>,
  ) {
    const owner = yield* entry(cwd);
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (owner.activity || owner.active)
          return yield* new GitManagerError({
            operation: "action",
            cwd,
            detail: "A Git workflow is already running for this checkout.",
          });
        owner.activity = { label, startedAtMs: 0 };
        const startedAtMs = yield* Clock.currentTimeMillis;
        owner.activity = { label, startedAtMs };
        yield* SubscriptionRef.set(owner.ref, {
          kind: "git_action",
          state: "running",
          label,
          startedAtMs,
          activity: owner.activity,
          steps: [],
        });
        const report = (nextLabel: string) =>
          Effect.suspend(() => {
            const activity = { label: nextLabel, startedAtMs };
            owner.activity = activity;
            return SubscriptionRef.update(owner.ref, (current) =>
              current ? { ...current, activity } : current,
            );
          });
        const finish = (state: GitWorkflowProgress["state"]) =>
          Effect.suspend(() => {
            delete owner.activity;
            return SubscriptionRef.update(owner.ref, (current) => {
              if (!current) return null;
              const { activity: _activity, ...rest } = current;
              return {
                ...rest,
                state,
                label:
                  state === "completed"
                    ? rest.kind === "git_action"
                      ? `${label}: completed`
                      : rest.label
                    : state === "cancelled"
                      ? "Git action cancelled"
                      : "Git action failed",
              };
            });
          });
        return yield* restore(Effect.suspend(() => action(report))).pipe(
          Effect.tap(() => finish("completed")),
          Effect.onError((cause) =>
            finish(Cause.hasInterruptsOnly(cause) ? "cancelled" : "failed"),
          ),
        );
      }),
    );
  });
  return {
    run,
    withActivity,
    clear: Effect.fn("WorkflowProgress.clear")(function* (cwd: string) {
      const owner = yield* entry(cwd);
      yield* SubscriptionRef.set(
        owner.ref,
        owner.activity
          ? {
              kind: "git_action",
              state: "running",
              startedAtMs: owner.activity.startedAtMs,
              label: owner.activity.label,
              activity: owner.activity,
              steps: [],
            }
          : null,
      );
    }),
    subscribe: (cwd: string) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const owner = yield* entry(cwd);
          return SubscriptionRef.changes(owner.ref).pipe(
            Stream.ensuring(
              Effect.sync(() => {
                owner.readers--;
              }),
            ),
            Stream.onStart(
              Effect.sync(() => {
                owner.readers++;
              }),
            ),
          );
        }),
      ),
  };
});
