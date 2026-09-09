import { describe, expect, it } from "vite-plus/test";

import {
  formatWorkspaceAbsolutePath,
  formatWorkspaceRelativePath,
  resolveChangedFilePaths,
} from "./filePathDisplay";

describe("formatWorkspaceRelativePath", () => {
  it("formats absolute workspace paths from the workspace root", () => {
    expect(
      formatWorkspaceRelativePath(
        "C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501");
  });

  it("prefixes relative paths with the workspace root label", () => {
    expect(
      formatWorkspaceRelativePath(
        "apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501");
  });

  it("keeps paths already rooted at the workspace label stable", () => {
    expect(
      formatWorkspaceRelativePath(
        "t3code/apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501");
  });

  it("preserves columns when present", () => {
    expect(
      formatWorkspaceRelativePath(
        "/C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts:501:9",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501:9");
  });

  it("keeps double-slash POSIX paths case-sensitive", () => {
    expect(formatWorkspaceRelativePath("//tmp/project/probe.txt", "//tmp/Project")).toBe(
      "//tmp/project/probe.txt",
    );
  });

  it("formats paths that include the workspace label as absolute workspace paths", () => {
    expect(
      formatWorkspaceAbsolutePath(
        "t3code/apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts:501");
  });

  it("collapses absolute and workspace-relative aliases for changed files", () => {
    expect(
      resolveChangedFilePaths(
        ["/home/me/projects/jobagent/individuell/target.php", "jobagent/individuell/target.php"],
        "/home/me/projects/jobagent",
      ),
    ).toEqual([
      {
        displayPath: "jobagent/individuell/target.php",
        fullPath: "/home/me/projects/jobagent/individuell/target.php",
      },
    ]);
  });

  it("keeps distinct changed files while resolving their full paths", () => {
    expect(
      resolveChangedFilePaths(
        ["apps/web/src/index.ts", "apps/web/src/main.ts"],
        "/home/me/projects/t3code",
      ),
    ).toEqual([
      {
        displayPath: "t3code/apps/web/src/index.ts",
        fullPath: "/home/me/projects/t3code/apps/web/src/index.ts",
      },
      {
        displayPath: "t3code/apps/web/src/main.ts",
        fullPath: "/home/me/projects/t3code/apps/web/src/main.ts",
      },
    ]);
  });

  it("keeps differently cased POSIX paths distinct", () => {
    expect(
      resolveChangedFilePaths(
        ["/home/me/project/File.ts", "/home/me/project/file.ts"],
        "/home/me/project",
      ),
    ).toHaveLength(2);
  });

  it("collapses differently cased Windows path aliases", () => {
    expect(
      resolveChangedFilePaths(
        ["c:/users/mike/project/src/File.ts", "project/src/file.ts"],
        "C:/Users/Mike/Project",
      ),
    ).toEqual([
      {
        displayPath: "Project/src/File.ts",
        fullPath: "c:/users/mike/project/src/File.ts",
      },
    ]);
  });
});
