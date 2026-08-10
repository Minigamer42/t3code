import { describe, expect, it, vi } from "vite-plus/test";

import { openDiffFilePrimaryAction, resolveDiffPathForWorkspace } from "./diffFileActions";

describe("openDiffFilePrimaryAction", () => {
  it("opens diff files in the main editor", () => {
    const openInEditor = vi.fn();

    openDiffFilePrimaryAction({
      filePath: "apps/web/src/components/DiffPanel.tsx",
      activeCwd: "/repo/project",
      openInEditor,
    });

    expect(openInEditor).toHaveBeenCalledWith(
      "/repo/project/apps/web/src/components/DiffPanel.tsx",
    );
  });

  it("opens repository-relative diff files from a nested project", () => {
    const openInEditor = vi.fn();

    openDiffFilePrimaryAction({
      filePath: "frontend/Dockerfile",
      activeCwd: "/repo/frontend",
      repositoryRoot: "/repo",
      openInEditor,
    });

    expect(openInEditor).toHaveBeenCalledWith("/repo/frontend/Dockerfile");
  });

  it("preserves repository-relative paths in a separate worktree", () => {
    expect(
      resolveDiffPathForWorkspace({
        filePath: "frontend/Dockerfile",
        workspaceRoot: "/worktrees/feature",
        repositoryRoot: "/repo",
      }),
    ).toBe("frontend/Dockerfile");
  });

  it("handles Windows roots and mixed diff separators", () => {
    expect(
      resolveDiffPathForWorkspace({
        filePath: "Frontend/src\\index.ts",
        workspaceRoot: "C:\\repo\\frontend",
        repositoryRoot: "C:\\repo",
      }),
    ).toBe("src/index.ts");
  });

  it.each([
    { workspaceRoot: "/frontend", repositoryRoot: "/" },
    { workspaceRoot: "C:\\frontend", repositoryRoot: "C:\\" },
  ])("handles filesystem roots: $repositoryRoot", ({ workspaceRoot, repositoryRoot }) => {
    expect(
      resolveDiffPathForWorkspace({
        filePath: "frontend/index.ts",
        workspaceRoot,
        repositoryRoot,
      }),
    ).toBe("index.ts");
  });

  it.each(["backend/server.ts", "frontend2/app.ts", "frontend/../secret.ts", "C:secret.ts"])(
    "does not open an out-of-project diff path: %s",
    (filePath) => {
      const openInEditor = vi.fn();

      openDiffFilePrimaryAction({
        filePath,
        activeCwd: "/repo/frontend",
        repositoryRoot: "/repo",
        openInEditor,
      });

      expect(openInEditor).not.toHaveBeenCalled();
    },
  );

  it("passes through paths when the workspace root is unavailable", () => {
    const openInEditor = vi.fn();

    openDiffFilePrimaryAction({
      filePath: "apps/web/src/components/DiffPanel.tsx",
      activeCwd: undefined,
      openInEditor,
    });

    expect(openInEditor).toHaveBeenCalledWith("apps/web/src/components/DiffPanel.tsx");
  });
});
