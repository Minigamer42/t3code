import type { EnvironmentId } from "@t3tools/contracts";
import { ScrollView, View } from "react-native";
import { gitEnvironment } from "../../../state/git";
import { useEnvironmentQuery } from "../../../state/query";
import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";

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
    <View className="gap-2">
      <Text className="text-xs text-foreground-secondary">
        Split after a commit to make a lower layer. Branch names are generated on save using your
        repository policy. The current branch remains the top part.
      </Text>
      {range.error ? (
        <Text className="text-destructive">{range.error}</Text>
      ) : range.isPending ? (
        <Text className="text-foreground-secondary">Loading commits…</Text>
      ) : commits.length < 2 ? (
        <Text className="text-foreground-secondary">
          This layer needs at least two commits to split.
        </Text>
      ) : (
        <ScrollView className="max-h-80" nestedScrollEnabled>
          {commits.map((commit, index) => {
            const selected = points.includes(commit.sha);
            return (
              <View key={commit.sha} className="gap-2 border-b border-subtle-strong py-3">
                <Text className="font-t3-medium text-foreground">{commit.subject}</Text>
                <Text className="text-xs text-foreground-secondary">{commit.shortSha}</Text>
                {index < commits.length - 1 ? (
                  <Button
                    size="compact"
                    tone={selected ? "primary" : "text"}
                    label={selected ? "New layer ends here" : "Split here"}
                    accessibilityLabel={`Split after ${commit.shortSha}: ${commit.subject}`}
                    onPress={() =>
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
                  />
                ) : (
                  <Text className="text-xs text-foreground-secondary">Current branch tip</Text>
                )}
              </View>
            );
          })}
        </ScrollView>
      )}
      {points.length > 0 ? (
        <Text className="text-xs text-foreground-secondary">
          {points.length} new {points.length === 1 ? "layer" : "layers"} · existing commits are
          preserved
        </Text>
      ) : null}
    </View>
  );
}
