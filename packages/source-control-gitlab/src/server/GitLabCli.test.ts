import { assert, it, afterEach, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import { VcsProcessExitError } from "@t3tools/contracts";

import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitLabCli from "./GitLabCli.ts";

const mockedRun = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>();
const layer = it.layer(
  GitLabCli.layer.pipe(Layer.provide(TestSourceControlHost.layer({ process: { run: mockedRun } }))),
);

function processOutput(stdout: string): SourceControlHost.SourceControlProcessOutput {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

afterEach(() => {
  mockedRun.mockReset();
});

layer("GitLabCli.layer", (it) => {
  it.effect.each([
    ["open", "opened"],
    ["closed", "closed"],
    ["merged", "merged"],
    ["all", "all"],
  ] as const)("maps the %s state to the GitLab API %s state", ([state, expectedState]) =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput("[]")));

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.listMergeRequests({
        cwd: "/repo",
        headSelector: "feature/mr-list",
        state,
        limit: 7,
      });

      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.arrayContaining([`state=${expectedState}`, "per_page=7"]),
        }),
      );
    }),
  );

  it.effect("creates merge requests through the GitLab API without placing the body in argv", () =>
    Effect.gen(function* () {
      mockedRun
        .mockReturnValueOnce(
          Effect.succeed(processOutput('{"remove_source_branch_after_merge":true}')),
        )
        .mockReturnValueOnce(Effect.succeed(processOutput("{}")));

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.createMergeRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "owner:feature/provider",
        title: "Provider MR",
        bodyFile: "/tmp/t3-mr-body.md",
        body: "## Summary\n\nProvider MR body",
      });

      expect(mockedRun).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: ["api", "projects/:fullpath"],
        }),
      );
      expect(mockedRun).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: [
            "api",
            "--method",
            "POST",
            "projects/:fullpath/merge_requests",
            "--raw-field",
            "source_branch=feature/provider",
            "--raw-field",
            "target_branch=main",
            "--raw-field",
            "title=Provider MR",
            "--field",
            "remove_source_branch=true",
            "--field",
            "description=@-",
          ],
          stdin: "## Summary\n\nProvider MR body",
        }),
      );
    }),
  );

  it.effect("preserves a disabled project source branch removal setting", () =>
    Effect.gen(function* () {
      mockedRun
        .mockReturnValueOnce(
          Effect.succeed(processOutput('{"remove_source_branch_after_merge":false}')),
        )
        .mockReturnValueOnce(Effect.succeed(processOutput("{}")));

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.createMergeRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "feature/provider",
        title: "Provider MR",
        bodyFile: "/tmp/t3-mr-body.md",
        body: "Merge request body",
      });

      expect(mockedRun).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: expect.arrayContaining([
            "--field",
            "remove_source_branch=false",
            "--field",
            "description=@-",
          ]),
          stdin: "Merge request body",
        }),
      );
    }),
  );

  it.effect("reads the configured merge request template", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              default_branch: "main",
              merge_requests_template: "  ## Summary\n\nDescribe the change.  ",
            }),
          ),
        ),
      );

      const glab = yield* GitLabCli.GitLabCli;
      const template = yield* glab.getConfiguredChangeRequestTemplate({ cwd: "/repo" });

      expect(template).toBe("## Summary\n\nDescribe the change.");
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: ["api", "projects/:fullpath"],
        }),
      );
    }),
  );

  it.effect("parses merge request view output", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              iid: 42,
              title: "Add MR thread creation",
              web_url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/42",
              target_branch: "main",
              source_branch: "feature/mr-threads",
              sha: "a".repeat(40),
              state: "closed",
              closed_at: "2026-08-23T10:00:00Z",
              source_project_id: 101,
              target_project_id: 100,
              source_project: {
                path_with_namespace: "octocat/t3code",
              },
            }),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getMergeRequest({
          cwd: "/repo",
          reference: "42",
        });
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add MR thread creation",
        url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/42",
        baseRefName: "main",
        headRefName: "feature/mr-threads",
        headSha: "a".repeat(40),
        state: "closed",
        closedAt: "2026-08-23T10:00:00Z",
        mergedAt: null,
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/t3code",
        headRepositoryOwnerLogin: "octocat",
      });
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: ["mr", "view", "--output", "json", "--", "42"],
        }),
      );
      const classifyFailure = mockedRun.mock.calls.at(-1)?.[0].classifyFailure;
      assert.strictEqual(
        classifyFailure?.(
          "x gitlab.example.test has not been authenticated with glab. Run `glab auth login`",
        ),
        "authentication",
      );
      assert.strictEqual(
        classifyFailure?.(
          'Failed to get merge request 42: oauth2: "invalid_grant" "The provided authorization grant is invalid, expired, revoked, does not match the redirection URI used in the authorization request, or was issued to another client."',
        ),
        "authentication",
      );
    }),
  );

  it.effect("skips invalid entries when parsing MR lists", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify([
              {
                iid: 0,
                title: "invalid",
                web_url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/0",
                target_branch: "main",
                source_branch: "feature/invalid",
              },
              {
                iid: 43,
                title: "  Valid MR  ",
                web_url: " https://gitlab.com/pingdotgg/t3code/-/merge_requests/43 ",
                target_branch: " main ",
                source_branch: " feature/mr-list ",
                state: "merged",
                merged_at: "2026-08-23T11:00:00Z",
              },
            ]),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.listMergeRequests({
          cwd: "/repo",
          headSelector: "feature/mr-list",
          state: "all",
        });
      });

      assert.deepStrictEqual(result, [
        {
          number: 43,
          title: "Valid MR",
          url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/43",
          baseRefName: "main",
          headRefName: "feature/mr-list",
          state: "merged",
          closedAt: null,
          mergedAt: "2026-08-23T11:00:00Z",
        },
      ]);
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: [
            "api",
            "--method",
            "GET",
            "projects/:fullpath/merge_requests",
            "--raw-field",
            "source_branch=feature/mr-list",
            "--raw-field",
            "state=all",
            "--raw-field",
            "per_page=20",
            "--raw-field",
            "order_by=updated_at",
            "--raw-field",
            "sort=desc",
          ],
        }),
      );
    }),
  );

  it.effect(
    "retries oversized MR lists with smaller pages without losing same-named branches",
    () =>
      Effect.gen(function* () {
        const entries = Array.from({ length: 4 }, (_, index) => ({
          iid: index + 1,
          title: "MR " + index,
          // The first alone escapes past the default 1 MB cap; together they pass the list cap.
          description: index === 0 ? '"'.repeat(600_000) : "x".repeat(3_000_000),
          web_url: "https://gitlab.com/acme/web/-/merge_requests/" + (index + 1),
          target_branch: "main",
          source_branch: "feature",
          source_project_id: index === 3 ? 100 : 101,
          target_project_id: 100,
        }));
        mockedRun.mockImplementation((input) => {
          const size = Number(input.args.find((arg) => arg.startsWith("per_page="))?.split("=")[1]);
          const page = Number(
            input.args.find((arg) => arg.startsWith("page="))?.split("=")[1] ?? 1,
          );
          const raw = JSON.stringify(entries.slice((page - 1) * size, page * size));
          const cap = input.maxOutputBytes ?? 1_000_000;
          return Effect.succeed({
            ...processOutput(raw.slice(0, cap)),
            stdoutTruncated: raw.length > cap,
          });
        });
        const glab = yield* GitLabCli.GitLabCli;
        const result = yield* glab.listMergeRequests({
          cwd: "/repo",
          headSelector: "feature",
          state: "open",
          limit: 4,
        });
        assert.deepStrictEqual(
          result.map((mr) => mr.number),
          [1, 2, 3, 4],
        );
        assert.strictEqual(result[3]?.isCrossRepository, false);
      }),
  );

  it.effect("creates same-project MRs with the configured source-branch removal policy", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(processOutput(JSON.stringify({ remove_source_branch_after_merge: false }))),
      );
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput("{}")));
      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.createMergeRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "feature/fix",
        title: "Fix remote flow",
        bodyFile: "/tmp/body.md",
      });
      expect(mockedRun).toHaveBeenCalledTimes(2);
      expect(mockedRun).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          args: [
            "api",
            "--method",
            "POST",
            "projects/:fullpath/merge_requests",
            "--raw-field",
            "source_branch=feature/fix",
            "--raw-field",
            "target_branch=main",
            "--raw-field",
            "title=Fix remote flow",
            "--field",
            "remove_source_branch=false",
            "--field",
            "description=@/tmp/body.md",
          ],
        }),
      );
    }),
  );

  it.effect("surfaces a friendly error when the merge request is not found", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitLabCli.execute",
        command: "glab",
        cwd: "/repo",
        exitCode: 1,
        detail: "GET 404 merge request not found",
        failureKind: "not-found",
      });
      mockedRun.mockReturnValueOnce(Effect.fail(cause));

      const error = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getMergeRequest({
          cwd: "/repo",
          reference: "4888",
        });
      }).pipe(Effect.flip);

      assert.equal(error.message.includes("Merge request 4888 was not found"), true);
      assert.strictEqual(error._tag, "GitLabMergeRequestNotFoundError");
      assert.strictEqual(error.command, "glab");
      assert.strictEqual(error.cwd, "/repo");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message.includes(cause.detail), false);
    }),
  );

  it.effect.each([
    { repository: "group/project", args: ["api", "projects/group%2Fproject"] },
    {
      repository: "https://gitlab.example.com:8443/group/sub/project.git",
      args: ["api", "--hostname", "gitlab.example.com:8443", "projects/group%2Fsub%2Fproject"],
    },
    {
      repository: "https://gitlab.com/group/project/-/tree/main",
      args: ["api", "--hostname", "gitlab.com", "projects/group%2Fproject"],
    },
  ])("looks up $repository by its project path", ({ repository, args }) =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              path_with_namespace: "group/project",
              web_url: "https://sourcecontrol.example.com/group/project",
              http_url_to_repo: "https://sourcecontrol.example.com/group/project.git",
              ssh_url_to_repo: "git@sourcecontrol.example.com:group/project.git",
            }),
          ),
        ),
      );

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.getRepositoryCloneUrls({ cwd: "/repo", repository });

      expect(mockedRun).toHaveBeenCalledWith(expect.objectContaining({ command: "glab", args }));
    }),
  );

  it.effect("keeps non-merge-request not-found failures generic", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitLabCli.execute",
        command: "glab",
        cwd: "/repo",
        exitCode: 1,
        detail: "GET 404 project not found",
        failureKind: "not-found",
      });
      mockedRun.mockReturnValueOnce(Effect.fail(cause));

      const error = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "missing/project",
        });
      }).pipe(Effect.flip);

      assert.strictEqual(error._tag, "GitLabCliCommandError");
      assert.strictEqual(error.cause, cause);
    }),
  );

  it.effect("preserves rate-limit failures as a distinct error", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitLabCli.execute",
        command: "glab",
        cwd: "/repo",
        exitCode: 1,
        detail: "API rate limit exceeded.",
        failureKind: "rate-limited",
      });
      mockedRun.mockReturnValueOnce(Effect.fail(cause));

      const glab = yield* GitLabCli.GitLabCli;
      const error = yield* glab
        .execute({ cwd: "/repo", args: ["api", "projects"] })
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "GitLabCliRateLimitError");
      assert.strictEqual(error.cause, cause);
    }),
  );
});
