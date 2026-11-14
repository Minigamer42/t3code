import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  formatHostedThreadLink,
  guessThreadLinkRef,
  percentDecodedThreadLinkId,
  type ThreadLink,
  unknownThreadLinkLabel,
} from "@t3tools/shared/threadLinks";

import { configuredHostedAppUrl } from "../../hostedPairing";
import { useThreadLinkTarget, useThreadRefs, useThreadShell } from "../../state/entities";
import { UnresolvedChip } from "../contextChipParts";
import { ThreadContextChip } from "../ThreadContextChip";

/** `label` is the link's written text; an autolink has none. */
export function MarkdownThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly link: ThreadLink;
  readonly label: string | null;
}) {
  const environmentId = props.link.environmentId ?? props.environmentId;
  const decodedId = percentDecodedThreadLinkId(props.link.threadId);
  const written = useThreadLinkTarget(scopeThreadRef(environmentId, props.link.threadId));
  const decoded = useThreadLinkTarget(
    written.data === null && decodedId !== null ? scopeThreadRef(environmentId, decodedId) : null,
  );
  const local = written.data ?? decoded.data;
  const guess = local === null && props.link.environmentId === null;
  const refs = useThreadRefs(guess);
  const remote = useThreadShell(guess ? guessThreadLinkRef(props.link, refs) : null);
  const thread = local ?? remote;
  if (thread === null) {
    const pending = written.isPending || decoded.isPending;
    const unknown = pending
      ? "Loading thread…"
      : written.error || decoded.error
        ? "Could not load thread"
        : unknownThreadLinkLabel(props.link, props.environmentId);
    return <UnresolvedChip label={props.label ?? unknown} tooltip={unknown} />;
  }
  const ref = { environmentId: remote?.environmentId ?? environmentId, threadId: thread.id };
  const title = thread.title.trim() || props.label || "Untitled thread";
  return (
    <ThreadContextChip
      record={{ ...ref, title }}
      copyMarkdown={formatHostedThreadLink(ref, title, configuredHostedAppUrl())}
    />
  );
}
