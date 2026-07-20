import { type EnvironmentId, MessageId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  queuedTurnSubmissionToChatMessage,
  type QueuedTurnSubmission,
  useQueuedTurnStore,
} from "./queuedTurnStore";

const messageA = MessageId.make("message-a");
const messageB = MessageId.make("message-b");

function submission(messageId: MessageId, text = "Queued text"): QueuedTurnSubmission {
  return {
    messageId,
    environmentId: "environment-a" as EnvironmentId,
    input: {
      threadId: ThreadId.make("thread-a"),
      message: {
        messageId,
        role: "user",
        text,
        attachments: [],
      },
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
        options: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-07-20T15:36:20.000Z",
    },
    composer: {
      prompt: text,
      images: [],
      terminalContexts: [],
      elementContexts: [],
      previewAnnotations: [],
      reviewComments: [],
    },
    settings: {
      threadId: ThreadId.make("thread-a"),
      createdAt: "2026-07-20T15:36:20.000Z",
      runtimeMode: "full-access",
      interactionMode: "default",
    },
  };
}

beforeEach(() => {
  useQueuedTurnStore.setState({ byThreadKey: {} });
});

describe("queuedTurnStore", () => {
  it("keeps queues isolated by thread while callers navigate between chats", () => {
    const store = useQueuedTurnStore.getState();
    store.enqueue("environment-a:thread-a", submission(messageA));
    store.enqueue("environment-a:thread-b", submission(messageB));

    expect(
      useQueuedTurnStore.getState().byThreadKey["environment-a:thread-a"]?.submissions,
    ).toEqual([submission(messageA)]);
    expect(
      useQueuedTurnStore.getState().byThreadKey["environment-a:thread-b"]?.submissions,
    ).toEqual([submission(messageB)]);
  });

  it("preserves send state and removes only the requested submission", () => {
    const store = useQueuedTurnStore.getState();
    store.enqueue("environment-a:thread-a", submission(messageA));
    store.enqueue("environment-a:thread-a", submission(messageB));
    store.setSending("environment-a:thread-a", messageA, true);

    expect(
      useQueuedTurnStore
        .getState()
        .byThreadKey["environment-a:thread-a"]?.sendingMessageIds.has(messageA),
    ).toBe(true);
    expect(store.remove("environment-a:thread-a", messageA)).toEqual(submission(messageA));
    expect(
      useQueuedTurnStore
        .getState()
        .byThreadKey["environment-a:thread-a"]?.submissions.map(({ messageId }) => messageId),
    ).toEqual([messageB]);
  });

  it("reconstructs a queued timeline message from the dispatch payload", () => {
    expect(queuedTurnSubmissionToChatMessage(submission(messageA))).toEqual({
      id: messageA,
      role: "user",
      text: "Queued text",
      turnId: null,
      createdAt: "2026-07-20T15:36:20.000Z",
      updatedAt: "2026-07-20T15:36:20.000Z",
      streaming: false,
    });
  });
});
