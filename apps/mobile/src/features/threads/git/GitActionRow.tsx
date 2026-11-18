import { View } from "react-native";

import { IconButton } from "../../../components/ui/IconButton";
import { ListRowLayout, type ListRowContentProps } from "../../../components/ui/ListRowLayout";
import { RowPressable } from "../../../components/ui/RowPressable";

export function GitActionRow({
  onPress,
  onConfigure,
  ...props
}: ListRowContentProps & {
  onPress: () => void;
  onConfigure?: (() => void) | undefined;
}) {
  return (
    <View className="flex-row items-center bg-grouped-card">
      <RowPressable
        className="min-w-0 flex-1"
        accessibilityRole="button"
        accessibilityLabel={props.label}
        accessibilityState={{ disabled: Boolean(props.disabled) }}
        disabled={props.disabled}
        onPress={onPress}
      >
        <ListRowLayout {...props} />
      </RowPressable>
      {onConfigure ? (
        <IconButton
          accessibilityLabel={`${props.label} options`}
          icon="slider.horizontal.3"
          disabled={props.disabled}
          onPress={onConfigure}
        />
      ) : null}
    </View>
  );
}
