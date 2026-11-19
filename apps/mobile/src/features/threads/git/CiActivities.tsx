import type { EnvironmentId } from "@t3tools/contracts";
import { gitEnvironment } from "../../../state/git";
import { useEnvironmentQuery } from "../../../state/query";
import { useOpenLinkedThread } from "../useOpenLinkedThread";
import { ListSection } from "../../../components/ui/ListSection";
import { ListRow } from "../../../components/ui/ListRow";

export function CiActivities({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(gitEnvironment.ciActivities({ environmentId, input: {} }));
  const openThread = useOpenLinkedThread();
  const activities = (query.data ?? []).filter((activity) => activity.state !== "superseded");
  if (!activities.length) return null;
  return (
    <ListSection>
      {activities.map((activity) => (
        <ListRow
          key={activity.id}
          icon="arrow.triangle.branch"
          label={`CI · ${activity.branch} · ${activity.sha.slice(0, 7)}`}
          description={activity.label}
          onPress={() => {
            if (activity.threadId) openThread({ environmentId, threadId: activity.threadId });
          }}
        />
      ))}
    </ListSection>
  );
}
