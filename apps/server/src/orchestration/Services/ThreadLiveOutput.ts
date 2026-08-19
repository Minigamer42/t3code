import type {
  MessageId,
  OrchestrationThreadLiveOutput,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export interface AssistantLiveOutputInput {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly turnId: TurnId | null;
  readonly delta: string;
  readonly createdAt: string;
  readonly publish: boolean;
}

export interface ToolLiveOutputInput {
  readonly threadId: ThreadId;
  readonly itemId: ProviderItemId;
  readonly itemType: "command_execution" | "file_change";
  readonly turnId: TurnId | null;
  readonly delta: string;
  readonly createdAt: string;
}

export interface ThreadLiveOutputShape {
  readonly appendAssistant: (input: AssistantLiveOutputInput) => Effect.Effect<void>;
  readonly finishAssistant: (threadId: ThreadId, messageId: MessageId) => Effect.Effect<string>;
  readonly appendTool: (input: ToolLiveOutputInput) => Effect.Effect<void>;
  readonly finishTool: (threadId: ThreadId, itemId: ProviderItemId) => Effect.Effect<string>;
  readonly snapshot: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<OrchestrationThreadLiveOutput>>;
  readonly stream: Stream.Stream<OrchestrationThreadLiveOutput>;
}

export const ThreadLiveOutputDisabled: ThreadLiveOutputShape = {
  appendAssistant: () => Effect.void,
  finishAssistant: () => Effect.succeed(""),
  appendTool: () => Effect.void,
  finishTool: () => Effect.succeed(""),
  snapshot: () => Effect.succeed([]),
  stream: Stream.empty,
};
