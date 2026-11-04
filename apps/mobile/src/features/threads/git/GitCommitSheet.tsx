import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  buildCommitFileTree,
  flattenCommitFileTree,
  toggleCommitFiles,
} from "@t3tools/client-runtime/commit-file-tree";
import { useEffect, useMemo, useRef, useState } from "react";
import { CommandId, type GitStartCommitWorkflowInput } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Platform, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../../components/AndroidScreenHeader";
import { SymbolView } from "../../../components/AppSymbol";
import { MaterialScreenContent } from "../../../components/MaterialScreenContent";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../../components/AppText";
import { cn } from "../../../lib/cn";
import { useEnvironmentQuery } from "../../../state/query";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { vcsEnvironment } from "../../../state/vcs";
import { ThemedSwitch } from "../../../components/ThemedSwitch";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../state/preferences";
import { SheetActionButton } from "./gitSheetComponents";
import { gitEnvironment } from "../../../state/git";
import { useAtomCommand } from "../../../state/use-atom-command";
import { uuidv4 } from "../../../lib/uuid";

type GitCommitSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly workflow?: boolean;
}>;

export function GitCommitSheet(_props: GitCommitSheetProps) {
  const isWorkflow = _props.route.params.workflow === true;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  const { canWriteSourceControl, canChangeThreadBranch } = gitActions;

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
  const [workflowScope, setWorkflowScope] = useState<"working_tree" | "branch">("working_tree");
  const [baseRef, setBaseRef] = useState("");
  const [startingWorkflow, setStartingWorkflow] = useState(false);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [workflowResult, setWorkflowResult] = useState<string | null>(null);
  const [cancellingWorkflow, setCancellingWorkflow] = useState(false);
  const workflowRequest = useRef<{ key: string; input: GitStartCommitWorkflowInput } | null>(null);
  const startWorkflow = useAtomCommand(gitEnvironment.startCommitWorkflow, {
    reportFailure: false,
  });
  const cancelWorkflow = useAtomCommand(gitEnvironment.cancelCommitWorkflow, {
    reportFailure: false,
  });
  const inFlight = useRef<Parameters<typeof startWorkflow>[0] | null>(null);
  useEffect(
    () => () => {
      const active = inFlight.current;
      if (active)
        void cancelWorkflow({
          environmentId: active.environmentId,
          input: {
            commandId: active.input.commandId,
            cwd: active.input.cwd,
          },
        });
    },
    [cancelWorkflow],
  );
  const canStartWorkflow = useAtomValue(
    gitEnvironment.startCommitWorkflow.permissionAtom(selectedThread?.environmentId ?? null),
  );

  const selectedFiles = allFiles.filter((file) => !excludedFiles.has(file.path));
  const allSelected = selectedFiles.length === allFiles.length;
  const noneSelected = selectedFiles.length === 0;
  const selectedInsertions = selectedFiles.reduce((sum, file) => sum + file.insertions, 0);
  const selectedDeletions = selectedFiles.reduce((sum, file) => sum + file.deletions, 0);
  const selectedFilePreview = selectedFiles.slice(0, 3);
  const workflowUnavailable =
    selectedThread?.id !== _props.route.params.threadId ||
    selectedThread?.environmentId !== _props.route.params.environmentId ||
    !gitStatus.data?.refName ||
    (workflowScope === "working_tree"
      ? noneSelected
      : isDefaultRef || gitStatus.data?.hasWorkingTreeChanges !== false);
  const runWorkflow = async () => {
    if (
      !selectedThread ||
      !selectedThreadCwd ||
      !canStartWorkflow ||
      startingWorkflow ||
      workflowUnavailable ||
      !gitStatus.data?.refName
    )
      return;
    const payload = {
      threadId: selectedThread.id,
      cwd: selectedThreadCwd,
      expectedBranch: gitStatus.data.refName,
      scope:
        workflowScope === "branch"
          ? { type: "branch" as const, ...(baseRef.trim() ? { baseRef: baseRef.trim() } : {}) }
          : {
              type: "working_tree" as const,
              ...(!allSelected ? { filePaths: selectedFiles.map((file) => file.path) } : {}),
            },
      ...(dialogCommitMessage.trim() ? { instructions: dialogCommitMessage.trim() } : {}),
    };
    const key = JSON.stringify(payload);
    if (workflowRequest.current?.key !== key)
      workflowRequest.current = {
        key,
        input: {
          ...payload,
          commandId: CommandId.make(uuidv4()),
        },
      };
    setStartingWorkflow(true);
    setWorkflowError(null);
    const target = {
      environmentId: selectedThread.environmentId,
      input: workflowRequest.current.input,
    };
    inFlight.current = target;
    const result = await startWorkflow(target);
    inFlight.current = null;
    setStartingWorkflow(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setWorkflowError(cause instanceof Error ? cause.message : "Could not split commits.");
      return;
    }
    setWorkflowResult(result.value.summary);
  };

  const cancelPendingWorkflow = async () => {
    if (!selectedThread || !workflowRequest.current || cancellingWorkflow) return;
    setCancellingWorkflow(true);
    const result = await cancelWorkflow({
      environmentId: selectedThread.environmentId,
      input: {
        commandId: workflowRequest.current.input.commandId,
        cwd: workflowRequest.current.input.cwd,
      },
    });
    setCancellingWorkflow(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setWorkflowError(
        cause instanceof Error ? cause.message : "Could not cancel commit splitting.",
      );
    } else workflowRequest.current = null;
  };

  const runCommitAction = async (featureBranch: boolean) => {
    if (!canWriteSourceControl || (featureBranch && !canChangeThreadBranch)) return;
    const commitMessage = dialogCommitMessage.trim();
    navigation.goBack();
    await gitActions.onRunSelectedThreadGitAction({
      action: "commit",
      featureBranch,
      ...(commitMessage ? { commitMessage } : {}),
      ...(!allSelected ? { filePaths: selectedFiles.map((file) => file.path) } : {}),
    });
  };

  return (
    <View
      collapsable={false}
      className="bg-sheet ios:flex-1"
      style={Platform.OS === "android" ? { maxHeight: windowHeight * 0.92 } : undefined}
    >
      {Platform.OS === "android" ? (
        <NativeStackScreenOptions
          options={{
            sheetCornerRadius: 28,
            sheetAllowedDetents: "fitToContents",
          }}
        />
      ) : null}
      {Platform.OS === "android" ? (
        <AndroidSheetHeader
          title={isWorkflow ? "Split into logical commits" : "Commit changes"}
          onBack={() => navigation.goBack()}
          hideBottomBorder
        />
      ) : null}
      <MaterialScreenContent fitToContents>
        <ScrollView
          nestedScrollEnabled
          className="android:shrink android:grow-0 ios:flex-1"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
          contentContainerClassName="android:gap-2 android:p-2 ios:gap-4 ios:px-5 ios:pt-2"
          contentContainerStyle={
            Platform.OS === "android"
              ? { paddingBottom: Math.max(insets.bottom, 18) + 18 }
              : undefined
          }
        >
          {isWorkflow && (
            <View className="gap-3 bg-card p-4 android:rounded-[20px] ios:rounded-[22px]">
              <Text className="text-foreground-secondary text-sm">
                Build and check a dependency-ordered commit sequence using your Source Control
                settings, independently without chat history. Final contents and a backup of the
                original history are preserved. Nothing is pushed.
              </Text>
              {(["working_tree", "branch"] as const).map((scope) => (
                <Pressable
                  key={scope}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: workflowScope === scope }}
                  disabled={startingWorkflow}
                  onPress={() => setWorkflowScope(scope)}
                  className="min-h-12 flex-row items-center gap-2"
                >
                  <Text className="text-foreground text-sm">
                    {workflowScope === scope ? "●" : "○"}{" "}
                    {scope === "working_tree" ? "Uncommitted changes" : "Existing branch commits"}
                  </Text>
                </Pressable>
              ))}
              {workflowScope === "branch" && (
                <>
                  <TextInput
                    accessibilityLabel="Base branch"
                    value={baseRef}
                    onChangeText={setBaseRef}
                    maxLength={256}
                    placeholder="Repository default branch"
                    autoCapitalize="none"
                    autoCorrect={false}
                    className="min-h-12 rounded-xl bg-subtle px-4"
                    editable={!startingWorkflow}
                  />
                  {workflowUnavailable && (
                    <Text className="text-warning-foreground text-sm">
                      Use a feature branch with a clean working tree to rebuild existing commits.
                    </Text>
                  )}
                </>
              )}
            </View>
          )}
          <View className="gap-3 bg-card p-4 android:rounded-[20px] ios:rounded-[22px] ios:border ios:border-border">
            <View className="android:gap-1 ios:flex-row ios:items-center ios:justify-between ios:gap-3">
              <Text className="text-foreground-muted text-sm font-medium">Branch</Text>
              <Text className="text-foreground text-base android:font-t3-medium ios:font-t3-bold">
                {gitStatus.data?.refName ?? "(detached HEAD)"}
              </Text>
            </View>
            {isDefaultRef ? (
              <Text className="text-xs leading-normal text-warning-foreground">
                Warning: this is the default branch.
              </Text>
            ) : null}
          </View>

          <View
            className="gap-3 bg-card p-4 android:rounded-[20px] ios:rounded-[22px] ios:border ios:border-border"
            style={isWorkflow && workflowScope === "branch" ? { display: "none" } : undefined}
          >
            <View className="flex-row items-center justify-between gap-3">
              <View className="gap-1">
                <Text className="text-foreground text-base android:font-t3-medium ios:font-t3-bold">
                  Files
                </Text>
                <Text className="text-foreground-muted text-xs leading-normal">
                  {selectedFiles.length} selected · +{formatDiffCount(selectedInsertions)} / -
                  {formatDiffCount(selectedDeletions)}
                </Text>
              </View>
              <View className="flex-row items-center gap-2">
                {!allSelected && isEditingFiles ? (
                  <Pressable
                    className="rounded-full px-3 android:min-h-12 android:justify-center android:active:bg-subtle ios:bg-subtle ios:py-2"
                    onPress={() => setExcludedFiles(new Set())}
                  >
                    <Text className="android:text-primary-text android:text-sm android:font-t3-medium ios:text-foreground ios:text-2xs ios:font-t3-bold ios:uppercase">
                      Reset
                    </Text>
                  </Pressable>
                ) : null}
                <Pressable
                  className="rounded-full px-3 android:min-h-12 android:justify-center android:active:bg-subtle ios:bg-subtle ios:py-2"
                  onPress={() => setIsEditingFiles((current) => !current)}
                >
                  <Text className="android:text-primary-text android:text-sm android:font-t3-medium ios:text-foreground ios:text-2xs ios:font-t3-bold ios:uppercase">
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
                  const includedCount = files.filter(
                    (file) => !excludedFiles.has(file.path),
                  ).length;
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
                            name={checked === "mixed" ? "minus" : checked ? "checkmark" : "circle"}
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
                              <Text className="text-xs font-t3-bold text-adaptive-emerald-700-300">
                                +{node.file.insertions}
                              </Text>
                              <Text className="text-xs font-t3-bold text-adaptive-rose-700-300">
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
                    <Text className="text-xs font-t3-bold text-adaptive-emerald-700-300">
                      +{formatDiffCount(file.insertions)}
                    </Text>
                    <Text className="text-xs font-t3-bold text-adaptive-rose-700-300">
                      -{formatDiffCount(file.deletions)}
                    </Text>
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
                        "px-4 py-3 android:rounded-xl ios:rounded-[18px] ios:border",
                        included
                          ? "android:bg-subtle ios:border-border"
                          : "ios:border-border-subtle",
                      )}
                      accessibilityRole="checkbox"
                      accessibilityLabel={file.path}
                      accessibilityState={{ checked: included }}
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
                      {Platform.OS !== "android" ? (
                        <View
                          className={`absolute inset-0 rounded-[18px] ${included ? "bg-card" : "bg-subtle"}`}
                        />
                      ) : null}
                      <View className="flex-row items-start justify-between gap-3">
                        {Platform.OS === "android" ? (
                          <View
                            className={cn(
                              "mt-0.5 size-5 items-center justify-center rounded-sm",
                              included ? "bg-primary" : "border border-input-border",
                            )}
                          >
                            {included ? (
                              <SymbolView
                                name="checkmark"
                                size={16}
                                tintColorClassName="accent-primary-foreground"
                                type="monochrome"
                              />
                            ) : null}
                          </View>
                        ) : null}
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
                          <Text className="text-xs font-t3-bold text-adaptive-emerald-700-300">
                            +{formatDiffCount(file.insertions)}
                          </Text>
                          <Text className="text-xs font-t3-bold text-adaptive-rose-700-300">
                            -{formatDiffCount(file.deletions)}
                          </Text>
                        </View>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>
          <View className="android:gap-3 android:rounded-[20px] android:bg-card android:p-4 ios:gap-2">
            <Text className="text-foreground android:text-base android:font-t3-medium ios:text-sm ios:font-t3-bold">
              {isWorkflow ? "Additional instructions (optional)" : "Commit message"}
            </Text>
            <TextInput
              multiline
              accessibilityLabel={isWorkflow ? "Additional instructions" : "Commit message"}
              value={dialogCommitMessage}
              onChangeText={setDialogCommitMessage}
              placeholder={
                isWorkflow
                  ? "Independent helpers first, then core implementation and integration…"
                  : "Leave empty to auto-generate"
              }
              maxLength={isWorkflow ? 10_000 : undefined}
              editable={!startingWorkflow}
              textAlignVertical="top"
              className="min-h-[128px] px-4 py-3.5 android:rounded-xl android:bg-sheet-solid ios:rounded-[20px]"
            />
          </View>

          {workflowError && (
            <Text accessibilityRole="alert" className="text-danger-foreground text-sm">
              {workflowError}
            </Text>
          )}
          {workflowResult && (
            <Text selectable className="text-foreground text-sm leading-normal">
              {workflowResult}
            </Text>
          )}
          {isWorkflow ? (
            <>
              {startingWorkflow && (
                <SheetActionButton
                  icon="xmark"
                  label={cancellingWorkflow ? "Cancelling…" : "Cancel"}
                  disabled={cancellingWorkflow}
                  onPress={() => void cancelPendingWorkflow()}
                />
              )}
              <SheetActionButton
                icon="arrow.branch"
                label={
                  workflowResult ? "Done" : startingWorkflow ? "Splitting…" : "Split into commits"
                }
                tone="primary"
                disabled={
                  !workflowResult &&
                  (!canStartWorkflow || workflowUnavailable || busy || startingWorkflow)
                }
                onPress={() => (workflowResult ? navigation.goBack() : void runWorkflow())}
              />
            </>
          ) : (
            <View className="android:gap-2 ios:flex-row ios:gap-3">
              <View className="ios:flex-1">
                <SheetActionButton
                  icon="arrow.branch"
                  label="Commit on new branch"
                  disabled={!canChangeThreadBranch || noneSelected || busy}
                  onPress={() => void runCommitAction(true)}
                />
              </View>
              <View className="ios:flex-1">
                <SheetActionButton
                  icon="checkmark.circle"
                  label="Commit"
                  tone="primary"
                  disabled={!canWriteSourceControl || noneSelected || busy}
                  onPress={() => void runCommitAction(false)}
                />
              </View>
            </View>
          )}
        </ScrollView>
      </MaterialScreenContent>
    </View>
  );
}
