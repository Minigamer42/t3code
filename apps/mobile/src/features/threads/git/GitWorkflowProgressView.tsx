import type { GitWorkflowProgress, GitWorkflowStep } from "@t3tools/contracts";
import { View } from "react-native";
import { AppText as Text } from "../../../components/ui/AppText";
import { cn } from "../../../lib/cn";

const stepColors: Record<GitWorkflowStep["state"], string> = {
  pending: "bg-blue-500",
  skipped: "bg-subtle-strong",
  running: "bg-blue-500",
  completed: "bg-emerald-500",
  failed: "bg-danger-foreground",
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
  return (
    <View className="gap-3 rounded-xl bg-card p-4">
      <View className="flex-row items-center gap-2">
        <Text numberOfLines={2} className="min-w-0 flex-1 text-sm text-foreground">
          {progress.activity?.label ??
            (progress.state === "running"
              ? progress.kind === "stack"
                ? "Stack progress"
                : progress.kind === "logical_commits"
                  ? "Logical commits"
                  : progress.label
              : progress.label)}
        </Text>
        {stages.length > 0 ? (
          <Text className="text-xs text-foreground-secondary">
            {finished}/{stages.length} {progress.kind === "logical_commits" ? "stages" : "steps"}
          </Text>
        ) : null}
      </View>
      {[...groups].map(([group, steps]) => {
        const multipleCommits =
          progress.kind === "logical_commits" &&
          steps.length > 1 &&
          steps.every((step) => step.id.startsWith("commit:"));
        const completed = steps.filter((step) => step.state === "completed").length;
        return (
          <View
            key={group}
            className={cn("gap-1", multipleCommits && "ml-1 border-l border-subtle-strong pl-3")}
          >
            {multipleCommits ? (
              <View className="flex-row items-center justify-between gap-2">
                <Text className="text-xs text-foreground-secondary">Create commits</Text>
                <Text className="text-xs text-foreground-secondary">
                  {completed}/{steps.length} commits
                </Text>
              </View>
            ) : null}
            {progress.kind === "stack" ? (
              <Text numberOfLines={1} className="text-xs text-foreground-secondary">
                {group}
              </Text>
            ) : null}
            {multipleCommits ? (
              <View
                accessible
                accessibilityRole="progressbar"
                accessibilityLabel={group}
                accessibilityValue={{
                  min: 0,
                  max: steps.length,
                  now: completed,
                  text: steps.map((step) => `${step.label}: ${step.state}`).join(", "),
                }}
                className="flex-row gap-1"
              >
                {steps.map((step) => (
                  <View
                    key={step.id}
                    className={cn("h-1.5 min-w-0 flex-1 rounded-sm", stepColors[step.state])}
                  />
                ))}
              </View>
            ) : (
              <View className="gap-1">
                {steps.map((step) => (
                  <View key={step.id} className="flex-row items-baseline justify-between gap-2">
                    <Text
                      numberOfLines={1}
                      className="min-w-0 flex-1 text-xs text-foreground-secondary"
                    >
                      {step.label}
                    </Text>
                    <Text
                      className={cn("text-xs", {
                        "text-foreground-secondary": step.state === "skipped",
                        "text-blue-500": step.state === "pending" || step.state === "running",
                        "text-emerald-500": step.state === "completed",
                        "text-danger-foreground": step.state === "failed",
                      })}
                    >
                      {step.state}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}
