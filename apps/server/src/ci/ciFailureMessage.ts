import type { CiActivity } from "@t3tools/contracts";

export function ciFailureMessage(
  activity: Pick<CiActivity, "branch" | "sha" | "label"> & {
    readonly pipeline: { readonly url: string } | null;
    readonly cwd?: string;
  },
  instructions: string,
) {
  const checkout = activity.cwd ? `\nPublished checkout: ${activity.cwd}.` : "";
  return `CI failed for ${activity.branch} at ${activity.sha}. ${activity.pipeline?.url ?? "No pipeline found."}\n${activity.label}${checkout}\n\n${instructions}\n\nThis concerns the published revision above. First recheck its remote head and CI result; a newer publication may already fix it. Inspect the checkout and check which agents currently use it before changing files. This notification does not reserve the checkout or authorize overwriting newer or unrelated work. A dirty or changed checkout is a reason to coordinate, not to discard the failure: follow the project's checkout/slot policy and contact its existing coordinator or owner when needed. Do not switch, reset, clean or stash another agent's checkout to make room. If an idle checkout is dirty, preserve unrelated changes; if you cannot safely proceed or obtain a slot, ask the user a concrete question through the available user-input tool and remain visibly waiting for the answer. Do not silently finish or park the failure merely because the checkout changed.`;
}
