import type { GitWorkflowProgress, GitWorkflowStep } from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";

const stepColors: Record<GitWorkflowStep["state"], string> = {
  pending: "bg-muted-foreground/20",
  skipped: "bg-muted-foreground/20",
  running: "bg-primary",
  completed: "bg-success",
  failed: "bg-destructive",
};
export function GitWorkflowProgressView({ progress }: { readonly progress: GitWorkflowProgress }) {
  const visibleSteps =
    progress.kind === "stack"
      ? progress.steps.filter((step) => step.state !== "skipped")
      : progress.steps;
  const groups = new Map<string, GitWorkflowStep[]>();
  for (const step of visibleSteps) {
    const group = groups.get(step.group) ?? [];
    group.push(step);
    groups.set(step.group, group);
  }
  const stages =
    progress.kind === "logical_commits"
      ? progress.steps.filter((step) => !step.id.startsWith("commit:"))
      : visibleSteps;
  const finished = stages.filter(
    (step) => step.state === "completed" || step.state === "skipped",
  ).length;
  const heading =
    progress.state === "running"
      ? progress.kind === "stack"
        ? "Stack progress"
        : progress.kind === "logical_commits"
          ? "Logical commits"
          : progress.label
      : progress.label;
  if (progress.kind === "git_action" && progress.activity) return null;
  return (
    <div
      className="min-w-0 space-y-2 px-2.5 py-2"
      role="region"
      aria-label={
        progress.kind === "stack"
          ? "Stack progress"
          : progress.kind === "logical_commits"
            ? "Logical commit progress"
            : "Git action progress"
      }
    >
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <Tooltip>
          <TooltipTrigger render={<p className="min-w-0 flex-1 truncate" />}>
            {heading}
          </TooltipTrigger>
          <TooltipPopup>{progress.label}</TooltipPopup>
        </Tooltip>
        {stages.length > 0 ? (
          <span className="shrink-0 tabular-nums">
            {finished}/{stages.length} {progress.kind === "logical_commits" ? "stages" : "steps"}
          </span>
        ) : null}
      </div>
      <div className="max-h-40 space-y-2 overflow-y-auto">
        {[...groups].map(([group, steps]) => {
          const multipleCommits =
            progress.kind === "logical_commits" &&
            steps.length > 1 &&
            steps.every((step) => step.id.startsWith("commit:"));
          const completed = steps.filter((step) => step.state === "completed").length;
          return (
            <div
              key={group}
              className={cn("space-y-1", multipleCommits && "ml-1 border-l border-border pl-3")}
            >
              {multipleCommits ? (
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>Create commits</span>
                  <span className="shrink-0 tabular-nums">
                    {completed}/{steps.length} commits
                  </span>
                </div>
              ) : null}
              {progress.kind === "stack" ? (
                <Tooltip>
                  <TooltipTrigger render={<p className="truncate text-xs text-muted-foreground" />}>
                    {group}
                  </TooltipTrigger>
                  <TooltipPopup>{group}</TooltipPopup>
                </Tooltip>
              ) : null}
              {multipleCommits ? (
                <div
                  role="progressbar"
                  aria-label={group}
                  aria-valuemin={0}
                  aria-valuemax={steps.length}
                  aria-valuenow={completed}
                  aria-valuetext={steps.map((step) => `${step.label}: ${step.state}`).join(", ")}
                  className="flex gap-1"
                >
                  {steps.map((step) => (
                    <Tooltip key={step.id}>
                      <TooltipTrigger
                        render={
                          <span
                            aria-hidden="true"
                            className={cn(
                              "h-1.5 min-w-0 flex-1 rounded-sm",
                              stepColors[step.state],
                            )}
                          />
                        }
                      />
                      <TooltipPopup>
                        {step.label}: {step.state}
                      </TooltipPopup>
                    </Tooltip>
                  ))}
                </div>
              ) : (
                <div className="space-y-1">
                  {steps.map((step) => (
                    <div
                      key={step.id}
                      className="flex items-baseline justify-between gap-2 text-xs"
                    >
                      <span className="min-w-0 truncate text-muted-foreground">{step.label}</span>
                      <span
                        className={cn("shrink-0", {
                          "text-muted-foreground":
                            step.state === "pending" || step.state === "skipped",
                          "text-primary": step.state === "running",
                          "text-success": step.state === "completed",
                          "text-destructive": step.state === "failed",
                        })}
                      >
                        {step.state}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
