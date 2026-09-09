import { beforeEach, describe, expect, it } from "vitest";
import { EnvironmentId, MessageId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import {
  queuedTurnSubmissionToChatMessage,
  useQueuedTurnStore,
  type QueuedTurnSubmission,
} from "./queuedTurnStore";

const threadKey = "environment-1:thread-1";
const messageA = MessageId.make("message-a");
const messageB = MessageId.make("message-b");

function submission(messageId: MessageId): QueuedTurnSubmission {
  const createdAt = "2026-07-15T12:00:00.000Z";
  const optimisticMessage = {
    id: messageId,
    role: "user" as const,
    text: `prompt-${messageId}`,
    turnId: null,
    createdAt,
    updatedAt: createdAt,
    streaming: false,
  };
  return {
    messageId,
    environmentId: EnvironmentId.make("environment-1"),
    input: {
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId,
        role: "user",
        text: optimisticMessage.text,
        attachments: [],
      },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      titleSeed: "prompt",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt,
    },
    optimisticMessage,
    composer: {
      prompt: optimisticMessage.text,
      images: [],
      files: [],
      terminalContexts: [],
      elementContexts: [],
      previewAnnotations: [],
      reviewComments: [],
    },
    settings: {
      threadId: ThreadId.make("thread-1"),
      createdAt,
      runtimeMode: "full-access",
      interactionMode: "default",
    },
  };
}

describe("queuedTurnStore", () => {
  beforeEach(() => {
    useQueuedTurnStore.setState({ byThreadKey: {} });
  });

  it("keeps queued turns in order and tracks sending state", () => {
    const store = useQueuedTurnStore.getState();
    store.enqueue(threadKey, submission(messageA));
    store.enqueue(threadKey, submission(messageB));
    useQueuedTurnStore.getState().setSending(threadKey, messageA, true);

    const queued = useQueuedTurnStore.getState().byThreadKey[threadKey];
    expect(queued?.submissions.map((entry) => entry.messageId)).toEqual([messageA, messageB]);
    expect(queued?.sendingMessageIds.has(messageA)).toBe(true);
  });

  it("removes and returns a queued turn", () => {
    useQueuedTurnStore.getState().enqueue(threadKey, submission(messageA));

    expect(useQueuedTurnStore.getState().remove(threadKey, messageA)?.messageId).toBe(messageA);
    expect(useQueuedTurnStore.getState().byThreadKey[threadKey]).toBeUndefined();
  });

  it("projects the retained optimistic message", () => {
    const queued = submission(messageA);
    expect(queuedTurnSubmissionToChatMessage(queued)).toBe(queued.optimisticMessage);
  });
});
