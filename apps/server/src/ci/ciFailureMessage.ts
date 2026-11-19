import type { CiActivity } from "@t3tools/contracts";

export function ciFailureMessage(
  activity: Pick<CiActivity, "branch" | "sha" | "label"> & {
    readonly pipeline: { readonly url: string } | null;
  },
  instructions: string,
) {
  return `CI failed for ${activity.branch} at ${activity.sha}. ${activity.pipeline?.url ?? "No pipeline found."}\n${activity.label}\n\n${instructions}\n\nThis concerns the published revision above. Recheck the remote head and checkout before changing files; do not overwrite newer or unrelated work.`;
}
