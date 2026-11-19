import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Linking, Pressable, View } from "react-native";
import { AppText as Text } from "../../../components/ui/AppText";
import { useAtomCommand } from "../../../state/use-atom-command";
import { Button } from "../../../components/ui/Button";
import { isCiActivityFinished, type EnvironmentId } from "@t3tools/contracts";
import { gitEnvironment } from "../../../state/git";
import { useEnvironmentQuery } from "../../../state/query";
import { useOpenLinkedThread } from "../useOpenLinkedThread";
import { ListSection } from "../../../components/ui/ListSection";
import { ListRow } from "../../../components/ui/ListRow";

export function CiActivities({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(gitEnvironment.ciActivities({ environmentId, input: {} }));
  const openThread = useOpenLinkedThread();
  const refresh = useAtomCommand(gitEnvironment.refreshCiActivities, { reportFailure: true });
  const canRefresh = useAtomValue(gitEnvironment.refreshCiActivities.permissionAtom(environmentId));
  const [refreshing, setRefreshing] = useState(false);
  const dismiss = useAtomCommand(gitEnvironment.dismissCiActivity, { reportFailure: true });
  const permitted = useAtomValue(gitEnvironment.dismissCiActivity.permissionAtom(environmentId));
  const activities = (query.data ?? []).filter((activity) => activity.state !== "superseded");
  if (!activities.length) return null;
  return (
    <ListSection>
      <View className="flex-row items-center gap-1 px-4">
        <Text className="text-xs text-foreground-secondary">CI</Text>
        <Button
          label=""
          icon="arrow.clockwise"
          size="compact"
          tone="text"
          accessibilityLabel={refreshing ? "Refreshing CI" : "Refresh CI"}
          disabled={!canRefresh || refreshing}
          onPress={() => {
            setRefreshing(true);
            void refresh({ environmentId, input: {} }).finally(() => setRefreshing(false));
          }}
        />
      </View>
      {activities.map((activity) => (
        <View key={activity.id} className="flex-row items-center">
          <View className="min-w-0 flex-1">
            <ListRow
              icon="arrow.triangle.branch"
              label={`${activity.branch} · ${activity.sha.slice(0, 7)}`}
              onPress={() => {
                if (activity.threadId) openThread({ environmentId, threadId: activity.threadId });
              }}
            />
            <View className="flex-row items-center gap-2 px-4 pb-2">
              <Text numberOfLines={1} className="min-w-0 shrink text-xs text-foreground-secondary">
                {activity.label}
              </Text>
              {activity.pipeline?.changeRequest ? (
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel={`Open MR #${activity.pipeline.changeRequest.number}`}
                  hitSlop={8}
                  onPress={() => {
                    if (activity.pipeline?.changeRequest)
                      void Linking.openURL(activity.pipeline.changeRequest.url);
                  }}
                >
                  <Text className="text-xs text-primary-text underline">
                    #{activity.pipeline.changeRequest.number}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </View>
          {isCiActivityFinished(activity) ? (
            <Button
              label="Dismiss"
              accessibilityLabel={`Dismiss CI for ${activity.branch}`}
              size="compact"
              tone="text"
              disabled={!permitted}
              onPress={() => {
                void dismiss({ environmentId, input: { activityId: activity.id } });
              }}
            />
          ) : null}
        </View>
      ))}
    </ListSection>
  );
}
