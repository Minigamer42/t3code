import { useAtomValue } from "@effect/atom-react";
import { View } from "react-native";
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
  const dismiss = useAtomCommand(gitEnvironment.dismissCiActivity, { reportFailure: true });
  const permitted = useAtomValue(gitEnvironment.dismissCiActivity.permissionAtom(environmentId));
  const activities = (query.data ?? []).filter((activity) => activity.state !== "superseded");
  if (!activities.length) return null;
  return (
    <ListSection>
      {activities.map((activity) => (
        <View key={activity.id} className="flex-row items-center">
          <View className="min-w-0 flex-1">
            <ListRow
              icon="arrow.triangle.branch"
              label={`CI · ${activity.branch} · ${activity.sha.slice(0, 7)}`}
              description={activity.label}
              onPress={() => {
                if (activity.threadId) openThread({ environmentId, threadId: activity.threadId });
              }}
            />
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
