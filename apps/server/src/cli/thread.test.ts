import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationV2ThreadLaunchInput,
  type ProjectSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  createThreadFromCliInput,
  ThreadCliTitleEmptyError,
  ThreadCliPromptEmptyError,
  ThreadCliModelSelectionError,
} from "./thread.ts";

const snapshot: ProjectSnapshot = {
  updatedAt: "2026-10-07T00:00:00.000Z",
  projects: [
    {
      id: ProjectId.make("project:test"),
      title: "Test",
      workspaceRoot: "/repo",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "project-model",
      },
      scripts: [],
      createdAt: "2026-10-07T00:00:00.000Z",
      updatedAt: "2026-10-07T00:00:00.000Z",
      deletedAt: null,
    },
  ],
};
const flags = {
  project: Option.some("project:test"),
  title: Option.none<string>(),
  prompt: Option.none<string>(),
  json: true,
  provider: Option.none<string>(),
  model: Option.none<string>(),
  reasoning: Option.none<string>(),
  fast: false,
};

const overrideSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: {
    ...DEFAULT_SERVER_SETTINGS.providerInstances,
    codex_work: {
      ...DEFAULT_SERVER_SETTINGS.providerInstances.codex!,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
    },
  },
};

it.effect("applies provider, model, reasoning and priority overrides to the launched thread", () =>
  Effect.gen(function* () {
    let launched: OrchestrationV2ThreadLaunchInput | undefined;
    yield* createThreadFromCliInput(
      {
        ...flags,
        provider: Option.some("codex_work"),
        model: Option.some("explicit-model"),
        reasoning: Option.some("high"),
        fast: true,
      },
      {
        snapshot,
        settings: overrideSettings,
        createProject: () => Effect.die("Must reuse the existing project"),
        launchThread: (input) => {
          launched = input;
          return Effect.succeed({ threadId: ThreadId.make("thread:test") });
        },
      },
    );
    assert.deepStrictEqual(launched?.modelSelection, {
      instanceId: "codex_work",
      model: "explicit-model",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "priority" },
      ],
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("requires an explicit model before changing provider instances", () =>
  Effect.gen(function* () {
    const error = yield* createThreadFromCliInput(
      { ...flags, provider: Option.some("codex_work") },
      {
        snapshot,
        settings: overrideSettings,
        createProject: () => Effect.die("Must not mutate"),
        launchThread: () => Effect.die("Must not mutate"),
      },
    ).pipe(Effect.flip);
    assert.instanceOf(error, ThreadCliModelSelectionError);
    assert.include(error.message, "--model is required");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("creates an empty thread without scheduling a first message", () =>
  Effect.gen(function* () {
    let launched: OrchestrationV2ThreadLaunchInput | undefined;
    const output = yield* createThreadFromCliInput(flags, {
      snapshot,
      settings: DEFAULT_SERVER_SETTINGS,
      createProject: () => Effect.die("The existing project must be reused"),
      launchThread: (input) => {
        launched = input;
        return Effect.succeed({ threadId: ThreadId.make("thread:test") });
      },
    });
    assert.include(output, '"started":false');
    assert.include(output, '"projectCreated":false');
    assert.strictEqual(launched?.title, "New thread");
    assert.strictEqual(launched?.modelSelection.model, "project-model");
    assert.strictEqual(launched?.initialMessage, undefined);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("starts a prompt using the active provider when the project default is disabled", () =>
  Effect.gen(function* () {
    let launched: OrchestrationV2ThreadLaunchInput | undefined;
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: {
        instanceId: ProviderInstanceId.make("claudeCode"),
        model: "active-model",
      },
      providerInstances: {
        ...DEFAULT_SERVER_SETTINGS.providerInstances,
        codex: { ...DEFAULT_SERVER_SETTINGS.providerInstances.codex!, enabled: false },
      },
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, enabled: false },
      },
    };
    const output = yield* createThreadFromCliInput(
      { ...flags, prompt: Option.some("  Investigate CI  ") },
      {
        snapshot,
        settings,
        createProject: () => Effect.die("The existing project must be reused"),
        launchThread: (input) => {
          launched = input;
          return Effect.succeed({ threadId: ThreadId.make("thread:test") });
        },
      },
    );
    assert.include(output, '"started":true');
    assert.strictEqual(launched?.title, "Investigate CI");
    assert.strictEqual(launched?.initialMessage?.text, "  Investigate CI  ");
    assert.strictEqual(launched?.modelSelection.model, "active-model");
  }).pipe(Effect.provide(NodeServices.layer)),
);

for (const [field, expected] of [
  ["title", ThreadCliTitleEmptyError],
  ["prompt", ThreadCliPromptEmptyError],
] as const) {
  it.effect("rejects a blank " + field + " before creating anything", () =>
    Effect.gen(function* () {
      const error = yield* createThreadFromCliInput(
        { ...flags, [field]: Option.some("  ") },
        {
          snapshot,
          settings: DEFAULT_SERVER_SETTINGS,
          createProject: () => Effect.die("Must not mutate"),
          launchThread: () => Effect.die("Must not mutate"),
        },
      ).pipe(Effect.flip);
      assert.instanceOf(error, expected);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}
