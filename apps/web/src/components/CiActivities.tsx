import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEnvironmentQuery } from "~/state/query";
import { gitEnvironment } from "~/state/git";
import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import { buildThreadRouteParams } from "~/threadRoutes";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { cn } from "~/lib/utils";

export function CiActivities({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(gitEnvironment.ciActivities({ environmentId, input: {} }));
  const navigate = useNavigate();
  const activities = (query.data ?? []).filter((activity) => activity.state !== "superseded");
  if (activities.length === 0) return null;
  return (
    <div
      className="max-h-48 min-w-0 overflow-y-auto border-t border-border px-2 py-3"
      aria-label="Background CI activities"
    >
      <p className="px-2 pb-1 text-xs text-muted-foreground">CI</p>
      {activities.map((activity) => (
        <ThreadDetailsControl
          key={activity.id}
          variant="ghost"
          multiline
          part="row"
          panel
          disabled={!activity.threadId}
          onClick={() => {
            if (activity.threadId)
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(scopeThreadRef(environmentId, activity.threadId)),
              });
          }}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs">
              {activity.branch} · {activity.sha.slice(0, 7)}
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className={cn(
                      "block truncate text-xs",
                      activity.state === "passed"
                        ? "text-success"
                        : activity.state === "failed"
                          ? "text-destructive"
                          : "text-muted-foreground",
                    )}
                  />
                }
              >
                {activity.label}
              </TooltipTrigger>
              <TooltipPopup>{activity.label}</TooltipPopup>
            </Tooltip>
            {activity.pipeline && (
              <span
                className="mt-1 flex gap-1"
                aria-label={`${activity.pipeline.jobs.filter((job) => job.status === "success").length} of ${activity.pipeline.jobs.length} jobs passed`}
              >
                {activity.pipeline.jobs.map((job) => (
                  <Tooltip key={job.id}>
                    <TooltipTrigger
                      render={
                        <span
                          className={cn(
                            "h-1 min-w-0 flex-1 rounded-full",
                            job.status === "success"
                              ? "bg-success"
                              : job.status === "failed" && !job.allowFailure
                                ? "bg-destructive"
                                : "bg-muted-foreground/20",
                          )}
                        />
                      }
                    />
                    <TooltipPopup>
                      {job.name}: {job.status}
                    </TooltipPopup>
                  </Tooltip>
                ))}
              </span>
            )}
          </span>
        </ThreadDetailsControl>
      ))}
    </div>
  );
}
