import {
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  ThreadId,
  CommandId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import type { AtomCommand } from "./runtime.ts";

interface PendingThreadUpdate {
  readonly threadId: ThreadId;
  readonly apply: (thread: OrchestrationV2ThreadShell) => OrchestrationV2ThreadShell;
  sequence?: number;
}

const QueuedUpdate = Schema.Struct({
  label: Schema.String,
  input: Schema.Struct({
    threadId: ThreadId,
    commandId: Schema.optionalKey(CommandId),
    snoozedUntil: Schema.optionalKey(Schema.String),
    reason: Schema.optionalKey(Schema.Literals(["user"])),
    restoreUnsettledAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
    orderKey: Schema.optionalKey(Schema.String),
  }),
  now: Schema.String,
});
type QueuedUpdate = typeof QueuedUpdate.Type;
const decodeQueue = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(QueuedUpdate)));

export interface OfflineThreadLifecycleOptions {
  readonly createCommandId: (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
  ) => Promise<CommandId>;
  readonly readyAtom: (environmentId: EnvironmentId) => Atom.Atom<boolean>;
  readonly storage?: {
    readonly read: (environmentId: EnvironmentId) => string | null;
    readonly write: (environmentId: EnvironmentId, value: string) => void;
  };
  readonly onFailure?: (result: unknown) => void;
}

export function createOptimisticThreadLifecycle(
  sourceSnapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationV2ShellSnapshot | null>,
  offline?: OfflineThreadLifecycleOptions,
) {
  const pendingAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<ReadonlyArray<PendingThreadUpdate>>([]).pipe(Atom.keepAlive),
  );
  const queuedByRegistry = new WeakMap<
    AtomRegistry.AtomRegistry,
    Map<EnvironmentId, QueuedUpdate[]>
  >();
  const restorers = new Map<
    string,
    (
      registry: AtomRegistry.AtomRegistry,
      environmentId: EnvironmentId,
      update: QueuedUpdate,
    ) => void
  >();
  const queueFor = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) => {
    let environments = queuedByRegistry.get(registry);
    if (!environments) {
      environments = new Map();
      queuedByRegistry.set(registry, environments);
    }
    const existing = environments.get(environmentId);
    if (existing) return existing;
    let updates: QueuedUpdate[] = [];
    try {
      const stored = offline?.storage?.read(environmentId);
      if (stored) updates = [...decodeQueue(stored)];
    } catch (error) {
      offline?.onFailure?.(error);
    }
    environments.set(environmentId, updates);
    const restored = [...updates];
    queueMicrotask(() => {
      for (const update of restored) restorers.get(update.label)?.(registry, environmentId, update);
    });
    return updates;
  };
  const save = (environmentId: EnvironmentId, queue: QueuedUpdate[]) =>
    offline?.storage?.write(environmentId, JSON.stringify(queue));
  const lanes = new WeakMap<AtomRegistry.AtomRegistry, Map<EnvironmentId, Promise<unknown>>>();
  const snapshotAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      if (offline) queueFor(get.registry, environmentId);
      const snapshot = get(sourceSnapshotAtom(environmentId));
      const pending = get(pendingAtom(environmentId));
      if (snapshot === null || pending.length === 0) return snapshot;
      const byThread = new Map<ThreadId, PendingThreadUpdate[]>();
      for (const update of pending) {
        if (update.sequence !== undefined && update.sequence <= snapshot.snapshotSequence) continue;
        const updates = byThread.get(update.threadId) ?? [];
        updates.push(update);
        byThread.set(update.threadId, updates);
      }
      if (byThread.size === 0) return snapshot;
      return {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          (byThread.get(thread.id) ?? []).reduce(
            (current, update) => update.apply(current),
            thread,
          ),
        ),
      };
    }),
  );

  // Until the durable snapshot catches up, an older pending update can still replace what shows.
  const pendingThreadIdsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): ReadonlySet<ThreadId> =>
        new Set(get(pendingAtom(environmentId)).map((update) => update.threadId)),
    ),
  );

  function wrap<Input extends { readonly threadId: ThreadId; readonly commandId?: CommandId }, E>(
    command: AtomCommand<
      { readonly environmentId: EnvironmentId; readonly input: Input },
      { readonly sequence: number },
      E
    >,
    apply: (
      thread: OrchestrationV2ThreadShell,
      input: Input,
      now: DateTime.Utc,
      accepted: boolean,
    ) => OrchestrationV2ThreadShell,
    queueOffline = false,
  ): typeof command {
    const run = async (
      registry: Parameters<typeof command.run>[0],
      target: Parameters<typeof command.run>[1],
      restored?: QueuedUpdate,
    ) => {
      const now = restored ? DateTime.makeUnsafe(restored.now) : DateTime.nowUnsafe();
      const queue = queueOffline && offline ? queueFor(registry, target.environmentId) : undefined;
      const deferred =
        restored !== undefined ||
        (queue !== undefined && !registry.get(offline!.readyAtom(target.environmentId)));
      const record: QueuedUpdate | undefined = deferred
        ? (restored ?? {
            label: command.label,
            input: {
              ...target.input,
              commandId:
                target.input.commandId ??
                (await offline!.createCommandId(registry, target.environmentId)),
            },
            now: DateTime.formatIso(now),
          })
        : undefined;
      if (record && !restored) {
        queue!.push(record);
        try {
          save(target.environmentId, queue!);
        } catch (error) {
          queue!.splice(queue!.indexOf(record), 1);
          throw error;
        }
      }
      const removeRecord = () => {
        if (!record || !queue) return;
        const index = queue.indexOf(record);
        if (index >= 0) {
          queue.splice(index, 1);
          save(target.environmentId, queue);
        }
      };
      const pending = pendingAtom(target.environmentId);
      const source = sourceSnapshotAtom(target.environmentId);
      const update: PendingThreadUpdate = {
        threadId: target.input.threadId,
        apply: (thread) =>
          apply(thread, target.input, now, deferred || update.sequence !== undefined),
      };
      const remove = () =>
        registry.update(pending, (current) => current.filter((item) => item !== update));
      registry.update(pending, (current) => [...current, update]);
      const execute = async () => {
        let confirmed = false;
        let failure: unknown;
        try {
          let result;
          for (;;) {
            if (deferred) {
              await new Promise<void>((resolve) => {
                const ready = offline!.readyAtom(target.environmentId);
                const unsubscribe = registry.subscribe(ready, (value) => {
                  if (value) {
                    unsubscribe();
                    resolve();
                  }
                });
                if (registry.get(ready)) {
                  unsubscribe();
                  resolve();
                }
              });
            }
            result =
              record?.input.snoozedUntil &&
              Date.parse(record.input.snoozedUntil) <= DateTime.toEpochMillis(DateTime.nowUnsafe())
                ? AsyncResult.success({ sequence: registry.get(source)?.snapshotSequence ?? 0 })
                : await command.run(
                    registry,
                    record ? { ...target, input: record.input as Input } : target,
                  );
            if (
              result._tag !== "Failure" ||
              !deferred ||
              registry.get(offline!.readyAtom(target.environmentId))
            )
              break;
          }
          if (result._tag === "Success") {
            update.sequence = result.value.sequence;
            registry.update(pending, (current) => [...current]);
            const reconcile = (snapshot: OrchestrationV2ShellSnapshot | null) => {
              if (snapshot === null || snapshot.snapshotSequence >= result.value.sequence) {
                remove();
                removeRecord();
                unsubscribe();
              }
            };
            const unsubscribe = registry.subscribe(source, reconcile);
            reconcile(registry.get(source));
            confirmed = true;
          }
          if (deferred && result._tag === "Failure") failure = result;
          return result;
        } finally {
          if (!confirmed) {
            remove();
            removeRecord();
          }
          if (failure) offline?.onFailure?.(failure);
        }
      };
      let environmentLanes = lanes.get(registry);
      if (!environmentLanes) {
        environmentLanes = new Map();
        lanes.set(registry, environmentLanes);
      }
      const previous = queueOffline ? environmentLanes.get(target.environmentId) : undefined;
      const result = previous ? previous.then(execute, execute) : execute();
      if (queueOffline) environmentLanes.set(target.environmentId, result);
      if (deferred) {
        void result.catch((error) => offline?.onFailure?.(error));
        return AsyncResult.success({ sequence: registry.get(source)?.snapshotSequence ?? 0 });
      }
      return result;
    };
    if (queueOffline)
      restorers.set(command.label, (registry, environmentId, update) => {
        void run(registry, { environmentId, input: update.input as Input }, update).catch((error) =>
          offline?.onFailure?.(error),
        );
      });
    return { label: command.label, run };
  }

  return { snapshotAtom, pendingThreadIdsAtom, wrap };
}
