import type {
  MessageId,
  OrchestrationThreadLiveOutput,
  ProviderItemId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { ThreadLiveOutputShape } from "../Services/ThreadLiveOutput.ts";

interface OutputEntry {
  readonly output: OrchestrationThreadLiveOutput;
  readonly text: string;
}

type OutputWithoutOffset =
  | Omit<Extract<OrchestrationThreadLiveOutput, { readonly type: "assistant" }>, "offset">
  | Omit<Extract<OrchestrationThreadLiveOutput, { readonly type: "tool" }>, "offset">;

const assistantKey = (threadId: ThreadId, messageId: MessageId) =>
  `assistant:${threadId}:${messageId}`;
const toolKey = (threadId: ThreadId, itemId: ProviderItemId) => `tool:${threadId}:${itemId}`;

const outputKey = (output: OrchestrationThreadLiveOutput) =>
  output.type === "assistant"
    ? assistantKey(output.threadId, output.messageId)
    : toolKey(output.threadId, output.itemId);

export const makeThreadLiveOutput = Effect.gen(function* () {
  const entries = yield* Ref.make<ReadonlyMap<string, OutputEntry>>(new Map());
  const pubSub = yield* PubSub.unbounded<OrchestrationThreadLiveOutput>();

  const append = (key: string, output: OutputWithoutOffset) =>
    Ref.modify(entries, (current) => {
      const existing = current.get(key);
      const offset = existing?.text.length ?? 0;
      const nextOutput = { ...output, offset } as OrchestrationThreadLiveOutput;
      const next = new Map(current);
      next.set(key, { output: nextOutput, text: `${existing?.text ?? ""}${output.delta}` });
      return [nextOutput, next] as const;
    });

  const finish = (key: string) =>
    Ref.modify(entries, (current) => {
      const existing = current.get(key);
      if (!existing) return ["", current] as const;
      const next = new Map(current);
      next.delete(key);
      return [existing.text, next] as const;
    });

  const coalescedStream = Stream.fromPubSub(pubSub).pipe(
    Stream.groupedWithin(128, "40 millis"),
    Stream.flatMap((batch) => {
      const byKey = new Map<string, OrchestrationThreadLiveOutput>();
      for (const output of batch) {
        const key = outputKey(output);
        const existing = byKey.get(key);
        if (existing && existing.offset + existing.delta.length === output.offset) {
          byKey.set(key, { ...existing, delta: `${existing.delta}${output.delta}` });
        } else {
          byKey.set(key, output);
        }
      }
      return Stream.fromIterable(byKey.values());
    }),
  );

  return {
    appendAssistant: (input) =>
      append(assistantKey(input.threadId, input.messageId), {
        type: "assistant",
        threadId: input.threadId,
        messageId: input.messageId,
        turnId: input.turnId,
        delta: input.delta,
        createdAt: input.createdAt,
      }).pipe(
        Effect.flatMap((output) =>
          input.publish ? PubSub.publish(pubSub, output).pipe(Effect.asVoid) : Effect.void,
        ),
      ),
    finishAssistant: (threadId, messageId) => finish(assistantKey(threadId, messageId)),
    appendTool: (input) =>
      append(toolKey(input.threadId, input.itemId), {
        type: "tool",
        threadId: input.threadId,
        itemId: input.itemId,
        itemType: input.itemType,
        turnId: input.turnId,
        delta: input.delta,
        createdAt: input.createdAt,
      }).pipe(
        Effect.flatMap((output) => PubSub.publish(pubSub, output)),
        Effect.asVoid,
      ),
    finishTool: (threadId, itemId) => finish(toolKey(threadId, itemId)),
    snapshot: (threadId) =>
      Ref.get(entries).pipe(
        Effect.map((current) =>
          Array.from(current.values()).flatMap((entry) =>
            entry.output.threadId !== threadId
              ? []
              : [{ ...entry.output, offset: 0, delta: entry.text }],
          ),
        ),
      ),
    stream: coalescedStream,
  } satisfies ThreadLiveOutputShape;
});
