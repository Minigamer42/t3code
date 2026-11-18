import type { EnvironmentId } from "@t3tools/contracts";
import { gitEnvironment } from "~/state/git";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";

export function StackLayerSplitPicker({
  environmentId,
  cwd,
  points,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly points: readonly string[];
  readonly onChange: (points: string[], headSha: string) => void;
}) {
  const range = useEnvironmentQuery(
    gitEnvironment.rewriteableCommits({ environmentId, input: { cwd } }),
  );
  const commits = range.data?.commits ?? [];
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Split after a commit to make a lower layer. Branch names are generated on save using your
        repository policy. The current branch remains the top part.
      </p>
      {range.error ? (
        <p className="text-xs text-destructive">{range.error}</p>
      ) : range.isPending ? (
        <p className="text-xs text-muted-foreground">Loading commits…</p>
      ) : commits.length < 2 ? (
        <p className="text-xs text-muted-foreground">
          This layer needs at least two commits to split.
        </p>
      ) : (
        <div className="overflow-hidden rounded-md border border-input">
          <ScrollArea className="h-72">
            <ol aria-label="Layer split boundaries" className="divide-y divide-border">
              {commits.map((commit, index) => {
                const selected = points.includes(commit.sha);
                return (
                  <li key={commit.sha} className="space-y-2 px-3 py-2.5">
                    <p className="break-words text-sm font-medium">{commit.subject}</p>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs text-muted-foreground">
                        {commit.shortSha}
                      </span>
                      {index < commits.length - 1 ? (
                        <Button
                          size="xs"
                          variant={selected ? "default" : "ghost-muted"}
                          aria-label={`Split after ${commit.shortSha}: ${commit.subject}`}
                          aria-pressed={selected}
                          onClick={() =>
                            onChange(
                              commits
                                .filter((candidate) =>
                                  candidate.sha === commit.sha
                                    ? !selected
                                    : points.includes(candidate.sha),
                                )
                                .map((candidate) => candidate.sha),
                              range.data!.headSha,
                            )
                          }
                        >
                          {selected ? "New layer ends here" : "Split here"}
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">Current branch tip</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </ScrollArea>
        </div>
      )}
      {points.length > 0 ? (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {points.length} new {points.length === 1 ? "layer" : "layers"} · existing commits are
          preserved
        </p>
      ) : null}
    </div>
  );
}
