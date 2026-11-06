import { buildCommitPlanPrompt } from "./textGenerationPrompts.ts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadTitlePrompt } from "./textGenerationPrompts.ts";
import { normalizeCliError } from "./textGenerationUtils.ts";

describe("normalizeCliError", () => {
  it("does not expose CLI failure details in the public error message", () => {
    const result = normalizeCliError(
      "codex",
      "generateCommitMessage",
      new Error("request failed with access_token=secret-token"),
      "Failed to generate a commit message",
    );

    expect(result.detail).toBe("Failed to generate a commit message");
    expect(result.message).not.toContain("secret-token");
  });
});

describe("buildThreadTitlePrompt", () => {
  it("names the project to leave out and puts the user's instructions above the limits", () => {
    for (const previousTitle of [undefined, "Hyperdrive Config Crash"]) {
      const { prompt } = buildThreadTitlePrompt({
        message: "hyperdrive init crashes without a config",
        previousTitle,
        projectTitle: "Hyperdrive",
        instructions: "Prefix every title with the team name.",
      });
      expect(prompt).toContain('Never include the project name ("Hyperdrive")');
      expect(prompt).not.toContain("fewer than 40 characters");
      expect(prompt).toContain("Title instructions from the user:\nPrefix every title");
    }
    expect(buildThreadTitlePrompt({ message: "Fix login", instructions: " " }).prompt).toContain(
      "3-8 words, fewer than 40 characters.",
    );
  });
});
describe("buildCommitPlanPrompt", () => {
  it("requires an exact, ordered partition of change-unit IDs", () => {
    const result = buildCommitPlanPrompt({
      branch: "feature/split",
      changeUnitSummary: "H001\tsrc/a.ts\t@@ -1 +1 @@\nH002\tsrc/a.test.ts\twhole-file change",
      annotatedPatch: "### H001 — src/a.ts\n@@ -1 +1 @@\n-old\n+new",
    });

    expect(result.prompt).toContain("use every ID from Available change units exactly once");
    expect(result.prompt).toContain(
      "order prerequisite commits before commits that depend on them",
    );
    expect(result.prompt).toContain("H002\tsrc/a.test.ts");
    expect(result.prompt).toContain("Branch: feature/split");
  });
});
