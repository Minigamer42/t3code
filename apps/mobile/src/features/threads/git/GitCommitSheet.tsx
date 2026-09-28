import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  buildCommitFileTree,
  flattenCommitFileTree,
  toggleCommitFiles,
} from "@t3tools/client-runtime/commit-file-tree";
import { useCallback, useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../../components/AppText";
import { cn } from "../../../lib/cn";
import { useEnvironmentQuery } from "../../../state/query";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { vcsEnvironment } from "../../../state/vcs";
import { SymbolView } from "../../../components/AppSymbol";
import { ThemedSwitch } from "../../../components/ThemedSwitch";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../state/preferences";
import { SheetActionButton } from "./gitSheetComponents";

type GitCommitSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

export function GitCommitSheet(_props: GitCommitSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();

  const gitStatus = useEnvironmentQuery(
    selectedThread !== null && selectedThreadCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );

  const busy = gitState.gitOperationLabel !== null;
  const isDefaultRef = gitStatus.data?.isDefaultRef ?? false;
  const allFiles = gitStatus.data?.workingTree?.files ?? [];

  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const groupByDirectory =
    AsyncResult.isSuccess(preferences) && preferences.value.gitFilesGroupByDirectory === true;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const tree = useMemo(
    () => (groupByDirectory ? buildCommitFileTree(allFiles) : []),
    [allFiles, groupByDirectory],
  );
  const groupedRows = useMemo(() => flattenCommitFileTree(tree, collapsed), [tree, collapsed]);

  const [dialogCommitMessage, setDialogCommitMessage] = useState("");
  const [excludedFiles, setExcludedFiles] = useState<ReadonlySet<string>>(new Set());
  const [isEditingFiles, setIsEditingFiles] = useState(false);

  const selectedFiles = allFiles.filter((file) => !excludedFiles.has(file.path));
  const allSelected = selectedFiles.length === allFiles.length;
  const noneSelected = selectedFiles.length === 0;
  const selectedInsertions = selectedFiles.reduce((sum, file) => sum + file.insertions, 0);
  const selectedDeletions = selectedFiles.reduce((sum, file) => sum + file.deletions, 0);
  const selectedFilePreview = selectedFiles.slice(0, 3);

  const runCommitAction = useCallback(
    async (featureBranch: boolean) => {
      const commitMessage = dialogCommitMessage.trim();
      navigation.goBack();
      await gitActions.onRunSelectedThreadGitAction({
        action: "commit",
        featureBranch,
        ...(commitMessage ? { commitMessage } : {}),
        ...(!allSelected ? { filePaths: selectedFiles.map((file) => file.path) } : {}),
      });
    },
    [allSelected, dialogCommitMessage, gitActions, navigation, selectedFiles],
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <AndroidSheetHeader title="Commit changes" onBack={() => navigation.goBack()} />
      ) : null}
      <ScrollView
        className="flex-1"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
        contentContainerClassName="gap-4 px-5 pt-2"
      >
        <View className="gap-3 rounded-[22px] border border-border bg-card px-4 py-4">
          <View className="flex-row items-center justify-between gap-3">
            <Text className="text-foreground-muted text-sm font-medium">Branch</Text>
            <Text className="text-foreground text-base font-t3-bold">
              {gitStatus.data?.refName ?? "(detached HEAD)"}
            </Text>
          </View>
          {isDefaultRef ? (
            <Text className="text-xs leading-normal text-warning-foreground">
              Warning: this is the default branch.
            </Text>
          ) : null}
        </View>

        <View className="gap-3 rounded-[22px] border border-border bg-card px-4 py-4">
          <View className="flex-row items-center justify-between gap-3">
            <View className="gap-1">
              <Text className="text-foreground text-base font-t3-bold">Files</Text>
              <Text className="text-foreground-muted text-xs leading-normal">
                {selectedFiles.length} selected · +{selectedInsertions} / -{selectedDeletions}
              </Text>
            </View>
            <View className="flex-row items-center gap-2">
              {!allSelected && isEditingFiles ? (
                <Pressable
                  className="bg-subtle rounded-full px-3 py-2"
                  onPress={() => setExcludedFiles(new Set())}
                >
                  <Text className="text-foreground text-2xs font-t3-bold uppercase">Reset</Text>
                </Pressable>
              ) : null}
              <Pressable
                className="bg-subtle rounded-full px-3 py-2"
                onPress={() => setIsEditingFiles((current) => !current)}
              >
                <Text className="text-foreground text-2xs font-t3-bold uppercase">
                  {isEditingFiles ? "Done" : "Edit"}
                </Text>
              </Pressable>
            </View>
          </View>

          {allFiles.length > 0 && (
            <View className="flex-row items-center justify-between gap-3">
              <Text className="text-foreground-muted text-sm">Group by directory</Text>
              <ThemedSwitch
                accessibilityLabel="Group by directory"
                value={groupByDirectory}
                disabled={!AsyncResult.isSuccess(preferences)}
                onValueChange={(value) => savePreferences({ gitFilesGroupByDirectory: value })}
              />
            </View>
          )}
          {allFiles.length === 0 ? (
            <Text className="text-foreground-secondary text-sm leading-normal">
              No changed files are available to commit.
            </Text>
          ) : groupByDirectory ? (
            <View className="gap-1">
              {groupedRows.map(({ node, depth }) => {
                const files = node.kind === "directory" ? node.files : [node.file];
                const includedCount = files.filter((file) => !excludedFiles.has(file.path)).length;
                const checked =
                  includedCount === files.length ? true : includedCount === 0 ? false : "mixed";
                return (
                  <View
                    key={`${node.kind}:${node.path}`}
                    className="flex-row items-center gap-2"
                    style={{ paddingLeft: depth * 12 }}
                  >
                    {isEditingFiles && (
                      <Pressable
                        accessibilityRole="checkbox"
                        accessibilityLabel={`Include ${node.kind === "directory" ? "directory " : ""}${node.path}`}
                        accessibilityState={{ checked }}
                        className="min-h-11 w-8 items-center justify-center"
                        onPress={() =>
                          setExcludedFiles((current) => toggleCommitFiles(files, current))
                        }
                      >
                        <SymbolView
                          name={
                            checked === "mixed"
                              ? "minus.square"
                              : checked
                                ? "checkmark.square"
                                : "square"
                          }
                          size={20}
                          tintColorClassName="accent-foreground"
                        />
                      </Pressable>
                    )}
                    {node.kind === "directory" ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={node.path}
                        accessibilityState={{ expanded: !collapsed.has(node.path) }}
                        className="min-h-11 flex-1 flex-row items-center gap-2"
                        onPress={() =>
                          setCollapsed((current) => {
                            const next = new Set(current);
                            if (next.has(node.path)) next.delete(node.path);
                            else next.add(node.path);
                            return next;
                          })
                        }
                      >
                        <SymbolView
                          name={collapsed.has(node.path) ? "chevron.right" : "chevron.down"}
                          size={12}
                          tintColorClassName="accent-foreground-muted"
                        />
                        <SymbolView
                          name="folder"
                          size={16}
                          tintColorClassName="accent-foreground-muted"
                        />
                        <Text
                          className="text-foreground flex-1 text-sm font-medium"
                          numberOfLines={1}
                        >
                          {node.name}
                        </Text>
                        <Text className="text-foreground-muted text-xs">{files.length}</Text>
                      </Pressable>
                    ) : (
                      <View
                        accessibilityLabel={node.path}
                        className="min-h-11 flex-1 flex-row items-center gap-2 pl-4"
                      >
                        <Text
                          className={cn(
                            "flex-1 text-sm",
                            includedCount ? "text-foreground" : "text-foreground-muted",
                          )}
                          numberOfLines={1}
                        >
                          {node.name}
                        </Text>
                        {includedCount ? (
                          <>
                            <Text className="text-xs font-t3-bold text-emerald-500">
                              +{node.file.insertions}
                            </Text>
                            <Text className="text-xs font-t3-bold text-rose-500">
                              -{node.file.deletions}
                            </Text>
                          </>
                        ) : (
                          <Text className="text-foreground-muted text-xs">Excluded</Text>
                        )}
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          ) : !isEditingFiles ? (
            <View className="gap-2">
              {selectedFilePreview.map((file) => (
                <View key={file.path} className="flex-row items-center justify-between gap-3">
                  <Text className="text-foreground flex-1 text-sm font-medium" numberOfLines={1}>
                    {file.path}
                  </Text>
                  <Text className="text-xs font-t3-bold text-emerald-500">+{file.insertions}</Text>
                  <Text className="text-xs font-t3-bold text-rose-500">-{file.deletions}</Text>
                </View>
              ))}
              {selectedFiles.length > selectedFilePreview.length ? (
                <Text className="text-foreground-muted text-xs leading-snug">
                  +{selectedFiles.length - selectedFilePreview.length} more files
                </Text>
              ) : null}
            </View>
          ) : (
            <View className="gap-2">
              {allFiles.map((file) => {
                const included = !excludedFiles.has(file.path);
                return (
                  <Pressable
                    key={file.path}
                    className={cn(
                      "rounded-[18px] border px-4 py-3",
                      included ? "border-border" : "border-border-subtle",
                    )}
                    onPress={() => {
                      setExcludedFiles((current) => {
                        const next = new Set(current);
                        if (next.has(file.path)) {
                          next.delete(file.path);
                        } else {
                          next.add(file.path);
                        }
                        return next;
                      });
                    }}
                  >
                    <View
                      className={`absolute inset-0 rounded-[18px] ${included ? "bg-card" : "bg-subtle"}`}
                    />
                    <View className="flex-row items-start justify-between gap-3">
                      <View className="flex-1 gap-1">
                        <Text
                          selectable
                          className={`text-sm font-t3-bold ${included ? "text-foreground" : "text-foreground-muted"}`}
                        >
                          {file.path}
                        </Text>
                        {!included ? (
                          <Text className="text-foreground-muted text-2xs leading-normal">
                            Excluded from this commit
                          </Text>
                        ) : null}
                      </View>
                      <View className="items-end gap-1">
                        <Text className="text-xs font-t3-bold text-emerald-500">
                          +{file.insertions}
                        </Text>
                        <Text className="text-xs font-t3-bold text-rose-500">
                          -{file.deletions}
                        </Text>
                      </View>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>

        <View className="gap-2">
          <Text className="text-foreground text-sm font-t3-bold">Commit message</Text>
          <TextInput
            multiline
            value={dialogCommitMessage}
            onChangeText={setDialogCommitMessage}
            placeholder="Leave empty to auto-generate"
            textAlignVertical="top"
            className="min-h-[128px] rounded-[20px] px-4 py-3.5"
          />
        </View>

        <View className="flex-row gap-3">
          <View className="flex-1">
            <SheetActionButton
              icon="arrow.branch"
              label="Commit on new branch"
              disabled={noneSelected || busy}
              onPress={() => void runCommitAction(true)}
            />
          </View>
          <View className="flex-1">
            <SheetActionButton
              icon="checkmark.circle"
              label="Commit"
              tone="primary"
              disabled={noneSelected || busy}
              onPress={() => void runCommitAction(false)}
            />
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
