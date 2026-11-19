import { SourceControlProviderKind } from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import { refineUnknownRemoteProvider } from "@t3tools/source-control-core/server/discovery";
import { processOutput } from "@t3tools/source-control-testing/TestSourceControlHost";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";

import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitLabCli from "./GitLabCli.ts";
import { parseGitLabAuthStatusHosts } from "./gitLabAuthStatus.ts";
import * as GitLabSourceControlProvider from "./GitLabSourceControlProvider.ts";
import { definition } from "../shared/definition.ts";

function makeProvider(
  gitlab: Partial<GitLabCli.GitLabCli["Service"]>,
  git?: TestSourceControlHost.TestSourceControlHostOptions["git"],
) {
  return GitLabSourceControlProvider.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(GitLabCli.GitLabCli)(gitlab),
        TestSourceControlHost.layer(git === undefined ? {} : { git }),
      ),
    ),
  );
}

it("accepts authenticated GitLab hosts when another configured host fails", () => {
  const auth = GitLabSourceControlProvider.discovery.parseAuth({
    exitCode: ChildProcessSpawner.ExitCode(1),
    stdout: `gitlab.com
  x gitlab.com: API call failed: 401 Unauthorized
  ! No token found
self-hosted.example.test
  ✓ Logged in to self-hosted.example.test as gitlab-user
  ✓ Token found: ******
`,
    stderr: "",
  });

  assert.deepStrictEqual(
    {
      status: auth.status,
      account: auth.account,
      host: auth.host,
    },
    {
      status: "authenticated",
      account: Option.some("gitlab-user"),
      host: Option.some("self-hosted.example.test"),
    },
  );
});

it("refines unknown GitLab remotes with mixed-case provider hosts", () => {
  const provider = GitLabSourceControlProvider.discovery.refineUnknownRemote?.({
    cwd: "/repo",
    context: {
      provider: {
        kind: SourceControlProviderKind.make("unknown"),
        name: "Self-Hosted.Example.Test",
        baseUrl: "https://Self-Hosted.Example.Test",
      },
      remoteName: "origin",
      remoteUrl: "https://Self-Hosted.Example.Test/group/project.git",
    },
    auth: {
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout: `self-hosted.example.test
  ✓ Logged in to self-hosted.example.test as gitlab-user
  ✓ Token found: ******
`,
      stderr: "",
    },
  });

  assert.deepStrictEqual(provider, {
    kind: "gitlab",
    name: "GitLab Self-Hosted",
    baseUrl: "https://Self-Hosted.Example.Test",
  });
});

it("tells a host glab has no login for apart from output that cannot say", () => {
  const refine = (stderr: string) =>
    GitLabSourceControlProvider.discovery.refineUnknownRemote?.({
      cwd: "/repo",
      context: {
        provider: {
          kind: SourceControlProviderKind.make("unknown"),
          name: "git.example.test",
          baseUrl: "https://git.example.test",
        },
        remoteName: "origin",
        remoteUrl: "https://git.example.test/group/project.git",
      },
      auth: { exitCode: ChildProcessSpawner.ExitCode(1), stdout: "", stderr },
    });

  assert.strictEqual(
    refine("x git.example.test has not been authenticated with glab. Run `glab auth login`"),
    null,
  );
  assert.strictEqual(
    refine("No GitLab instances have been authenticated with glab. Run `glab auth login`"),
    null,
  );
  assert.strictEqual(refine("git.example.test\n  x API call failed: 503"), undefined);
});

// regression: #15395 self-hosted GitLab remotes resolve bare MR numbers once glab is signed in
it.effect.each([
  [
    "https://code.example.test:8443@Code.Example.Test:8443/Team/Repo.git",
    true,
    "gitlab",
    "Code.Example.Test:8443",
  ],
  ["git@code.example.test:team/repo.git", true, "gitlab"],
  ["https://code.example.test/team/repo.git", false, "unknown"],
  ["https://github.com/team/repo.git", true, "github"],
] as const)(
  "resolves MR numbers for %s with authenticated=%s as %s",
  ([remoteUrl, authenticated, expectedProvider, expectedAuthHost = "code.example.test"]) =>
    Effect.gen(function* () {
      const provider = yield* makeProvider({});
      const identity = {
        canonicalKey: normalizeGitRemoteUrl(remoteUrl),
        locator: { source: "git-remote" as const, remoteName: "upstream", remoteUrl },
        rootPath: "/repo",
        // Only a remote no host recognised is left for glab to refine.
        provider: SourceControlProviderKind.make(
          expectedProvider === "github" ? "github" : "unknown",
        ),
      };
      let authCalls = 0;
      const refined = yield* (
        provider.refineRepositoryIdentity?.({
          identity,
          resolveContext: (input) =>
            refineUnknownRemoteProvider({
              ...input,
              specs: [GitLabSourceControlProvider.discovery],
              process: {
                run: ({ command, args, cwd }) => {
                  authCalls++;
                  assert.deepStrictEqual(
                    { command, args, cwd },
                    {
                      command: "glab",
                      args: ["auth", "status", "--hostname", expectedAuthHost],
                      cwd: "/repo",
                    },
                  );
                  return Effect.succeed(
                    processOutput(
                      authenticated
                        ? `${expectedAuthHost}\n  ✓ Logged in to ${expectedAuthHost} as gitlab-user\n`
                        : "x code.example.test has not been authenticated with glab.",
                      { exitCode: ChildProcessSpawner.ExitCode(authenticated ? 0 : 1) },
                    ),
                  );
                },
              },
            }).pipe(
              Effect.map(({ provider }) =>
                provider ? { ...input.context, provider } : input.context,
              ),
            ),
        }) ?? Effect.succeed(identity)
      );
      if (expectedProvider === "gitlab") {
        const [host, ...repository] = refined.canonicalKey.split("/");
        assert.strictEqual(
          definition.changeRequestUrl({
            host: host!,
            repository: repository.join("/"),
            number: 42,
          }),
          "https://code.example.test/team/repo/-/merge_requests/42",
        );
      }
      assert.deepStrictEqual(refined, {
        ...identity,
        provider: SourceControlProviderKind.make(expectedProvider),
      });
      if (expectedProvider === "github") assert.strictEqual(authCalls, 0);
    }),
);

it("parses authenticated GitLab auth status hosts with ports and single-label names", () => {
  assert.deepStrictEqual(
    parseGitLabAuthStatusHosts(`localhost:8080
  ✓ Logged in to localhost:8080 as local-user
selfhosted
  ✓ Logged in to selfhosted as single-label-user
`),
    [
      { host: "localhost:8080", account: "local-user" },
      { host: "selfhosted", account: "single-label-user" },
    ],
  );
});

it.effect(
  "looks up a branch's merge requests a full page at a time, past forks' same-named branches",
  () =>
    Effect.gen(function* () {
      const provider = yield* makeProvider({});
      assert.deepStrictEqual(
        provider.headBranchProbe?.({
          headSelectors: ["octocat:feature", "feature"],
          state: "open",
        }),
        { headSelectors: ["feature"], limit: 100 },
      );
    }),
);

it.effect.each(["merge_requests", "issues"])(
  "resolves %s subjects on the linked host without using the checkout",
  (kind) =>
    Effect.gen(function* () {
      const provider = yield* makeProvider({
        execute: (input) => {
          assert.deepStrictEqual(input.args, [
            "api",
            "--hostname",
            "gitlab.com",
            `projects/group%2Fsubgroup%2Fproject/${kind}/42`,
          ]);
          assert.strictEqual(input.maxOutputBytes, 32_000);
          assert.strictEqual(input.timeoutMs, 3_000);
          return Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: JSON.stringify({
              title: "Pairing expiry",
              description: "Preserve remote access",
            }),
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        },
      });
      const lookup = provider.resolveLink?.({
        cwd: "/unrelated",
        url: new URL(`https://gitlab.com/group/subgroup/project/-/${kind}/42`),
      });
      assert.ok(lookup);
      assert.deepStrictEqual(yield* lookup, {
        title: "Pairing expiry",
        body: "Preserve remote access",
      });
      for (const url of [
        "https://gitlab.com/owner/repo",
        "https://gitlab.attacker.test/team/project/-/issues/1",
      ]) {
        assert.strictEqual(
          provider.resolveLink?.({ cwd: "/unrelated", url: new URL(url) }),
          undefined,
        );
      }
    }),
);

it.effect.each(["read", "decode"] as const)(
  "retains the %s failure without exposing its raw contents",
  (stage) =>
    Effect.gen(function* () {
      const cause = new GitLabCli.GitLabCliCommandError({
        command: "glab",
        cwd: "/repo",
        operation: "execute",
        cause: new Error("private response text"),
      });
      const provider = yield* makeProvider({
        execute: () =>
          stage === "read"
            ? Effect.fail(cause)
            : Effect.succeed({
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "private response text",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              }),
      });
      const lookup = provider.resolveLink?.({
        cwd: "/repo",
        url: new URL("https://gitlab.com/owner/repo/-/issues/42"),
      });
      assert.ok(lookup);
      const error = yield* Effect.flip(lookup);
      assert.strictEqual(error.operation, stage === "read" ? "resolveLink" : "resolveLink.decode");
      assert.strictEqual(error.detail, "The linked subject could not be read.");
      assert.notInclude(error.message, "private response text");
      if (stage === "read") assert.strictEqual(error.cause, cause);
      else assert.propertyVal(error.cause, "_tag", "SchemaError");
    }),
);

it.effect.each([
  { headSelector: "octocat:feature/fix", source: undefined, sourceProject: "octocat/t3code" },
  {
    headSelector: "feature/fix",
    source: { owner: "team/subgroup", refName: "feature/fix" },
    sourceProject: "team/subgroup/t3code",
  },
  {
    headSelector: "feature/fix",
    source: { repository: "octocat/renamed-fork", refName: "feature/fix" },
    sourceProject: "octocat/renamed-fork",
  },
])("creates a fork MR from $sourceProject into the current project", (testCase) =>
  Effect.gen(function* () {
    const requests: ReadonlyArray<string>[] = [];
    const host = TestSourceControlHost.layer({
      process: {
        run: (input) => {
          requests.push(input.args);
          if (input.args[1] === "projects/:fullpath") {
            return Effect.succeed(
              processOutput(
                JSON.stringify({ id: 100, path: "t3code", remove_source_branch_after_merge: true }),
              ),
            );
          }
          assert.deepStrictEqual(input.args, [
            "api",
            "--method",
            "POST",
            `projects/${encodeURIComponent(testCase.sourceProject)}/merge_requests`,
            "--raw-field",
            "source_branch=feature/fix",
            "--raw-field",
            "target_branch=main",
            "--raw-field",
            "target_project_id=100",
            "--raw-field",
            "title=Fix remote flow",
            "--field",
            "remove_source_branch=true",
            "--field",
            "description=@/tmp/body.md",
          ]);
          return Effect.succeed(processOutput("{}"));
        },
      },
    });
    const provider = yield* GitLabSourceControlProvider.make.pipe(
      Effect.provide(Layer.merge(host, GitLabCli.layer.pipe(Layer.provide(host)))),
    );
    yield* provider.createChangeRequest({
      cwd: "/repo",
      baseRefName: "main",
      headSelector: testCase.headSelector,
      ...(testCase.source ? { source: testCase.source } : {}),
      title: "Fix remote flow",
      bodyFile: "/tmp/body.md",
    });
    assert.strictEqual(requests.length, 2);
    assert.deepStrictEqual(requests[0], ["api", "projects/:fullpath"]);
  }),
);
it.effect("prefers GitLab's configured template without reading repository defaults", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getConfiguredChangeRequestTemplate: () => Effect.succeed("Configured template"),
    });
    const template = yield* provider.readChangeRequestTemplate!({ cwd: "/repo", treeish: "main" });
    assert.deepEqual(template, Option.some("Configured template"));
  }),
);

it.effect(
  "falls back to the committed default template when GitLab has no configured template",
  () =>
    Effect.gen(function* () {
      const provider = yield* makeProvider(
        { getConfiguredChangeRequestTemplate: () => Effect.succeed(null) },
        {
          execute: (input) =>
            Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout:
                input.args[0] === "ls-tree"
                  ? `100644 blob ${"a".repeat(40)}\t.gitlab/merge_request_templates/Default.md\0`
                  : "Repository template\n",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        },
      );
      const template = yield* provider.readChangeRequestTemplate!({
        cwd: "/repo",
        treeish: "main",
      });
      assert.deepEqual(template, Option.some("Repository template"));
    }),
);

it.effect(
  "retargets an existing merge request without creating one or replacing its description",
  () =>
    Effect.gen(function* () {
      const commands: ReadonlyArray<string>[] = [];
      const provider = yield* makeProvider({
        execute: (input) => {
          commands.push(input.args);
          return Effect.succeed(processOutput(""));
        },
      });
      yield* provider.retargetChangeRequest!({
        cwd: "/repo",
        reference: "https://gitlab.example/group/repo/-/merge_requests/42",
        baseBranch: "main",
      });
      assert.deepStrictEqual(commands, [
        [
          "mr",
          "update",
          "--target-branch",
          "main",
          "--",
          "https://gitlab.example/group/repo/-/merge_requests/42",
        ],
      ]);
    }),
);

it.effect("reads and updates MR blockers on the MR's host and target project", () =>
  Effect.gen(function* () {
    const commands: ReadonlyArray<string>[] = [];
    const provider = yield* makeProvider({
      execute: (input) => {
        commands.push(input.args);
        if (input.args.includes("projects/other%2Fparent/merge_requests/3"))
          return Effect.succeed(processOutput(JSON.stringify({ id: 145 })));
        const method = input.args[input.args.indexOf("--method") + 1];
        return Effect.succeed(
          processOutput(
            method === "GET"
              ? JSON.stringify([
                  {
                    id: 7,
                    blocking_merge_request: {
                      web_url: "https://git.example:8443/other/parent/-/merge_requests/3",
                      state: "merged",
                    },
                  },
                  { id: 8 },
                ])
              : method === "POST"
                ? JSON.stringify({
                    id: 9,
                    blocking_merge_request: {
                      web_url: "https://git.example:8443/other/parent/-/merge_requests/3",
                    },
                  })
                : "",
          ),
        );
      },
    });
    const api = provider.changeRequestDependencies!;
    const reference = "https://git.example:8443/group/sub/target/-/merge_requests/42";
    assert.deepStrictEqual(yield* api.list({ cwd: "/fork-checkout", reference }), [
      { id: "7", url: "https://git.example:8443/other/parent/-/merge_requests/3", state: "merged" },
      { id: "8", url: null },
    ]);
    const edge = yield* api.add({
      cwd: "/fork-checkout",
      reference,
      blockingReference: "https://git.example:8443/other/parent/-/merge_requests/3",
    });
    yield* api.remove({ cwd: "/fork-checkout", reference, id: edge.id });
    assert.deepStrictEqual(commands, [
      [
        "api",
        "--hostname",
        "git.example:8443",
        "--method",
        "GET",
        "projects/group%2Fsub%2Ftarget/merge_requests/42/blocks?per_page=100",
      ],
      [
        "api",
        "--hostname",
        "git.example:8443",
        "--method",
        "GET",
        "projects/other%2Fparent/merge_requests/3",
      ],
      [
        "api",
        "--hostname",
        "git.example:8443",
        "--method",
        "POST",
        "projects/group%2Fsub%2Ftarget/merge_requests/42/blocks",
        "--field",
        "blocking_merge_request_id=145",
      ],
      [
        "api",
        "--hostname",
        "git.example:8443",
        "--method",
        "DELETE",
        "projects/group%2Fsub%2Ftarget/merge_requests/42/blocks/9",
      ],
    ]);
    const failed = yield* api
      .add({
        cwd: "/fork-checkout",
        reference,
        blockingReference: "https://another.example/other/parent/-/merge_requests/3",
      })
      .pipe(Effect.flip);
    assert.include(failed.message, "same GitLab host");
    assert.equal(commands.length, 4);
  }),
);

it.effect("tracks the pushed revision across merged-result and branch pipelines", () =>
  Effect.gen(function* () {
    const sha = "a".repeat(40);
    let newer = false;
    let parents = ["base", sha];
    let mr = true;
    const executeCalls: string[][] = [];
    const provider = yield* makeProvider({
      execute: (input) =>
        Effect.sync(() => {
          executeCalls.push([...input.args]);
          const endpoint = input.args[5]!;
          let value: unknown;
          if (input.args.includes("POST")) value = {};
          else if (endpoint.endsWith("/trace")) return processOutput("failed job trace");
          else if (endpoint.includes("repository/branches/"))
            value = { commit: { id: newer ? "new-head" : sha } };
          else if (endpoint.includes("merge_requests?"))
            value = mr ? [{ iid: 4, sha, source_project_id: 1, target_project_id: 1 }] : [];
          else if (endpoint.endsWith("merge_requests/4"))
            value = {
              head_pipeline: {
                id: 8,
                sha: "synthetic-merge",
                status: "failed",
                web_url: "https://git.example/pipelines/8",
              },
            };
          else if (endpoint.includes("repository/commits/")) value = { parent_ids: parents };
          else if (endpoint.includes("pipelines?"))
            value = [{ id: 9, sha, status: "running", web_url: "https://git.example/pipelines/9" }];
          else if (endpoint.includes("/jobs?"))
            value = [
              { id: 10, name: "test", status: "failed", web_url: null, allow_failure: false },
            ];
          else throw new Error(`Unexpected endpoint: ${endpoint}`);
          return processOutput(JSON.stringify(value));
        }),
    });
    const api = provider.ci!;
    const target = {
      cwd: "/checkout",
      host: "git.example:8443",
      repository: "group/sub/repo",
      branch: "feature/a",
      sha,
    };
    const merged = yield* api.read(target);
    assert.equal(merged.pipeline?.sha, "synthetic-merge");
    assert.equal(merged.pipeline?.jobs[0]?.id, "10");
    parents = ["base", "old-head"];
    assert.deepStrictEqual(yield* api.read(target), { current: true, pipeline: null });
    mr = false;
    assert.equal((yield* api.read(target)).pipeline?.sha, sha);
    newer = true;
    assert.deepStrictEqual(yield* api.read(target), { current: false, pipeline: null });
    assert.equal(yield* api.trace({ ...target, jobId: "10" }), "failed job trace");
    yield* api.run({ ...target, jobId: "10", action: "retry-job" });
    yield* api.run({ ...target, jobId: "11", action: "play-job" });
    assert.deepStrictEqual(
      executeCalls.slice(-2).map((args) => args.slice(-1)[0]),
      ["projects/group%2Fsub%2Frepo/jobs/10/retry", "projects/group%2Fsub%2Frepo/jobs/11/play"],
    );
    assert.equal(
      executeCalls.every((args) => args[2] === "git.example:8443"),
      true,
    );
  }),
);
