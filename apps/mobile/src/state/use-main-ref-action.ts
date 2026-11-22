import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { serverEnvironment } from "./server";

export function useCreateFeatureBranchOnMain(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return config
    ? resolveProjectSettings(config.settings, projectId).settings.createFeatureBranchOnMain
    : true;
}
