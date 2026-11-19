/// <reference lib="dom" />
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { run } from "./shell.ts";
import { runPromise, test, WEB } from "./t3.ts";

test(
  "A clean default branch with outgoing commits offers git actions",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("outgoing");
    await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const git = (args: ReadonlyArray<string>) => run("git", args, { cwd: project });
        const remote = `${project}.git`;
        yield* run("git", ["init", "--bare", "--initial-branch=main", remote]);
        yield* git(["remote", "add", "origin", remote]);
        yield* git(["push", "--set-upstream", "origin", "main"]);
        yield* fs.writeFileString(`${project}/README.md`, "Outgoing change\n");
        yield* git(["add", "README.md"]);
        yield* git([
          "-c",
          "user.name=Scenario",
          "-c",
          "user.email=scenario@example.invalid",
          "commit",
          "--message",
          "Local outgoing change",
        ]);
      }),
    );
    const thread = await t3.thread({ project, title: "Outgoing commits", messages: ["first"] });
    await t3.open(thread);
    await expect(screen.getByText("first fixture turn complete", { exact: false })).toBeVisible();
    if (
      !(await browser.evaluate(() => document.querySelector("[data-thread-details-card]") !== null))
    ) {
      await screen.getByRole("button", "Toggle thread details panel").tap();
    }
    await expect(
      screen.getByRole("button", "Create feature branch", { exact: true }),
    ).toBeEnabled();
    await expect(screen.getByRole("button", "Push", { exact: true })).toBeEnabled();
    await expect(screen.getByRole("button", "Push & create PR", { exact: true })).toBeEnabled();
    await app.screenshot("outgoing-git-actions");
    await screen.getByRole("button", "Push & create PR options", { exact: true }).tap();
    await expect(
      screen.getByRole("button", "Push on current branch", { exact: true }),
    ).toBeEnabled();
    await expect(screen.getByRole("button", "Push & create PR", { exact: true })).toBeEnabled();
    await app.screenshot("push-pr-dialog");
    await screen.getByRole("button", "Cancel", { exact: true }).tap();

    await screen.getByRole("button", "Push options", { exact: true }).tap();
    await expect(
      screen.getByRole("button", "Push on current branch", { exact: true }),
    ).toBeEnabled();
    await expect(screen.getByRole("button", "Push on new branch", { exact: true })).toBeEnabled();
    await app.screenshot("push-dialog");
    await screen.getByRole("button", "Push on current branch", { exact: true }).tap();
    await expect
      .poll(() =>
        runPromise(run("git", ["rev-list", "--count", "origin/main..main"], { cwd: project })).then(
          (result) => result.stdout.trim(),
        ),
      )
      .toBe("0");
    await expect
      .poll(() =>
        runPromise(run("git", ["branch", "--show-current"], { cwd: project })).then((result) =>
          result.stdout.trim(),
        ),
      )
      .toBe("main");
    await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${project}/README.md`, "Another local change\n");
      }),
    );
    await expect(screen.getByRole("button", "Commit options", { exact: true })).toBeEnabled();
    for (const label of ["Commit & push", "Commit, push & create PR"]) {
      await screen.getByRole("button", `${label} options`, { exact: true }).tap();
      await expect(
        screen.getByRole("button", "Commit & push on current branch", { exact: true }),
      ).toBeEnabled();
      await expect(screen.getByRole("button", label, { exact: true })).toBeEnabled();
      await app.screenshot(
        label === "Commit & push" ? "commit-push-dialog" : "commit-push-pr-dialog",
      );
      await screen.getByRole("button", "Cancel", { exact: true }).tap();
    }
    await screen.getByRole("button", "Commit options", { exact: true }).tap();
    await expect(
      screen.getByRole("button", "Commit on current branch", { exact: true }),
    ).toBeEnabled();
    await expect(
      screen.getByRole("button", "Create logical commits", { exact: true }),
    ).toBeEnabled();
    await app.screenshot("logical-commit-dialog");
    await screen.getByRole("radio", "Single commit", { exact: true }).tap();
    await screen.getByPlaceholder("Leave empty to auto-generate").fill("Commit on existing main");
    await app.screenshot("single-commit-dialog");
    await screen.getByRole("button", "Commit on current branch", { exact: true }).tap();
    await expect
      .poll(() =>
        runPromise(run("git", ["log", "-1", "--format=%s"], { cwd: project })).then((result) =>
          result.stdout.trim(),
        ),
      )
      .toBe("Commit on existing main");
    await expect
      .poll(() =>
        runPromise(run("git", ["branch", "--show-current"], { cwd: project })).then((result) =>
          result.stdout.trim(),
        ),
      )
      .toBe("main");
    await runPromise(
      Effect.gen(function* () {
        yield* run("git", ["checkout", "-b", "feature/existing"], { cwd: project });
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${project}/README.md`, "Feature branch change\n");
      }),
    );
    const featureThread = await t3.thread({
      project,
      title: "Existing feature branch",
      messages: ["first"],
    });
    await t3.open(featureThread);
    await expect(screen.getByText("first fixture turn complete", { exact: false })).toBeVisible();
    if (
      !(await browser.evaluate(() => document.querySelector("[data-thread-details-card]") !== null))
    ) {
      await screen.getByRole("button", "Toggle thread details panel").tap();
    }
    for (const label of ["Commit & push", "Commit, push & create PR"]) {
      await screen.getByRole("button", `${label} options`, { exact: true }).tap();
      await expect(
        screen.getByRole("button", "Commit & push on current branch", { exact: true }),
      ).not.toBeVisible();
      await screen.getByRole("button", "Cancel", { exact: true }).tap();
    }
    await screen.getByRole("button", "Commit options", { exact: true }).tap();
    await expect(
      screen.getByRole("button", "Create logical commits", { exact: true }),
    ).toBeEnabled();
    await expect(
      screen.getByRole("button", "Commit on current branch", { exact: true }),
    ).not.toBeVisible();
    await app.screenshot("feature-branch-logical-commit-dialog");
    await screen.getByRole("radio", "Single commit", { exact: true }).tap();
    await expect(
      screen.getByRole("button", "Commit on current branch", { exact: true }),
    ).not.toBeVisible();
    await screen
      .getByPlaceholder("Leave empty to auto-generate")
      .fill("Commit on existing feature");
    await app.screenshot("feature-branch-single-commit-dialog");
    await screen.getByRole("button", "Commit", { exact: true }).tap();
    await expect
      .poll(() =>
        runPromise(run("git", ["log", "-1", "--format=%s"], { cwd: project })).then((result) =>
          result.stdout.trim(),
        ),
      )
      .toBe("Commit on existing feature");
    await expect
      .poll(() =>
        runPromise(run("git", ["branch", "--show-current"], { cwd: project })).then((result) =>
          result.stdout.trim(),
        ),
      )
      .toBe("feature/existing");
  },
);
