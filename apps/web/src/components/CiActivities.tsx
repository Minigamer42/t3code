import { useAtomValue } from "@effect/atom-react";
import { XIcon } from "lucide-react";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { ciProgressJobs, isCiActivityFinished, type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEnvironmentQuery } from "~/state/query";
import { gitEnvironment } from "~/state/git";
import { buildThreadRouteParams } from "~/threadRoutes";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { cn } from "~/lib/utils";

export function CiActivities({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(gitEnvironment.ciActivities({ environmentId, input: {} }));
  const navigate = useNavigate();
  const dismiss = useAtomCommand(gitEnvironment.dismissCiActivity, { reportFailure: true });
  const permitted = useAtomValue(gitEnvironment.dismissCiActivity.permissionAtom(environmentId));
  const activities = (query.data ?? []).filter((activity) => activity.state !== "superseded");
  if (activities.length === 0) return null;
  return (
    <div
      className="max-h-48 min-w-0 overflow-y-auto border-t border-border px-2 py-3"
      aria-label="Background CI activities"
    >
      <p className="px-2 pb-1 text-xs text-muted-foreground">CI</p>
      {activities.map((activity) => {
        const jobs = ciProgressJobs(activity.pipeline?.jobs ?? []);
        const changeRequest = activity.pipeline?.changeRequest;
        return (
          <div key={activity.id} className="flex min-w-0 items-start">
            <div className="min-w-0 flex-1 px-2.5 py-1.5">
              <button
                type="button"
                className="block w-full cursor-pointer truncate rounded text-left text-xs outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default"
                disabled={!activity.threadId}
                onClick={() => {
                  if (activity.threadId)
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(
                        scopeThreadRef(environmentId, activity.threadId),
                      ),
                    });
                }}
              >
                {activity.branch} · {activity.sha.slice(0, 7)}
              </button>
              <div className="flex min-w-0 items-center gap-1 text-xs">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        className={cn(
                          "min-w-0 truncate",
                          activity.state === "failed"
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
                {changeRequest ? (
                  <a
                    href={changeRequest.url}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-muted-foreground underline underline-offset-2"
                  >
                    #{changeRequest.number}
                  </a>
                ) : null}
              </div>
              {jobs.length > 0 ? (
                <div
                  className="mt-1 flex gap-1"
                  aria-label={`${jobs.filter((job) => job.status === "success").length} of ${jobs.length} jobs passed`}
                >
                  {jobs.map((job) => (
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
                                  : job.status === "canceled" || job.status === "failed"
                                    ? "bg-muted-foreground/20"
                                    : "bg-info",
                            )}
                          />
                        }
                      />
                      <TooltipPopup>
                        {job.name}: {job.status}
                      </TooltipPopup>
                    </Tooltip>
                  ))}
                </div>
              ) : null}
            </div>
            {isCiActivityFinished(activity) ? (
              <div className="pt-1.5">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost-muted"
                        size="icon-xs"
                        aria-label={`Dismiss CI for ${activity.branch}`}
                        disabled={!permitted}
                        onClick={() => {
                          void dismiss({ environmentId, input: { activityId: activity.id } });
                        }}
                      >
                        <XIcon />
                      </Button>
                    }
                  />
                  <TooltipPopup>Dismiss</TooltipPopup>
                </Tooltip>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
