import type {
  EnvironmentId,
  MessageId,
  ModelSelection,
  PreviewAnnotationPayload,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import { create } from "zustand";

import type { ComposerFileAttachment, ComposerImageAttachment } from "./composerDraftStore";
import type { ElementContextDraft } from "./lib/elementContext";
import type { TerminalContextDraft } from "./lib/terminalContext";
import type { ReviewCommentContext } from "./reviewCommentContext";
import type { ChatMessage } from "./types";

export interface QueuedTurnSubmission {
  readonly messageId: MessageId;
  readonly environmentId: EnvironmentId;
  readonly input: StartThreadTurnInput;
  readonly optimisticMessage: ChatMessage;
  readonly composer: {
    readonly prompt: string;
    readonly images: ComposerImageAttachment[];
    readonly files: ComposerFileAttachment[];
    readonly terminalContexts: TerminalContextDraft[];
    readonly elementContexts: ElementContextDraft[];
    readonly previewAnnotations: PreviewAnnotationPayload[];
    readonly reviewComments: ReviewCommentContext[];
  };
  readonly settings: {
    readonly threadId: ThreadId;
    readonly createdAt: string;
    readonly modelSelection?: ModelSelection;
    readonly branch?: string;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
  };
}

export interface QueuedTurnThreadState {
  readonly submissions: ReadonlyArray<QueuedTurnSubmission>;
  readonly sendingMessageIds: ReadonlySet<MessageId>;
}

export const EMPTY_QUEUED_TURN_THREAD_STATE: QueuedTurnThreadState = {
  submissions: [],
  sendingMessageIds: new Set(),
};

interface QueuedTurnStoreState {
  readonly byThreadKey: Readonly<Record<string, QueuedTurnThreadState | undefined>>;
  readonly enqueue: (threadKey: string, submission: QueuedTurnSubmission) => void;
  readonly remove: (threadKey: string, messageId: MessageId) => QueuedTurnSubmission | null;
  readonly setSending: (threadKey: string, messageId: MessageId, sending: boolean) => void;
  readonly clearThread: (threadKey: string) => void;
}

function threadState(state: QueuedTurnStoreState, threadKey: string): QueuedTurnThreadState {
  return state.byThreadKey[threadKey] ?? EMPTY_QUEUED_TURN_THREAD_STATE;
}

export const useQueuedTurnStore = create<QueuedTurnStoreState>()((set) => ({
  byThreadKey: {},
  enqueue: (threadKey, submission) => {
    set((state) => {
      const current = threadState(state, threadKey);
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: {
            ...current,
            submissions: [...current.submissions, submission],
          },
        },
      };
    });
  },
  remove: (threadKey, messageId) => {
    let removed: QueuedTurnSubmission | null = null;
    set((state) => {
      const current = state.byThreadKey[threadKey];
      if (!current) return state;
      removed =
        current.submissions.find((submission) => submission.messageId === messageId) ?? null;
      if (!removed) return state;

      const submissions = current.submissions.filter(
        (submission) => submission.messageId !== messageId,
      );
      const sendingMessageIds = new Set(current.sendingMessageIds);
      sendingMessageIds.delete(messageId);
      if (submissions.length === 0 && sendingMessageIds.size === 0) {
        const { [threadKey]: _removedThread, ...byThreadKey } = state.byThreadKey;
        return { byThreadKey };
      }
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: { submissions, sendingMessageIds },
        },
      };
    });
    return removed;
  },
  setSending: (threadKey, messageId, sending) => {
    set((state) => {
      const current = state.byThreadKey[threadKey];
      if (!current) return state;
      const sendingMessageIds = new Set(current.sendingMessageIds);
      if (sending) sendingMessageIds.add(messageId);
      else sendingMessageIds.delete(messageId);
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: { ...current, sendingMessageIds },
        },
      };
    });
  },
  clearThread: (threadKey) => {
    set((state) => {
      if (!(threadKey in state.byThreadKey)) return state;
      const { [threadKey]: _removedThread, ...byThreadKey } = state.byThreadKey;
      return { byThreadKey };
    });
  },
}));

export function queuedTurnSubmissionToChatMessage(submission: QueuedTurnSubmission): ChatMessage {
  return submission.optimisticMessage;
}
