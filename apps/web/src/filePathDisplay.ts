import { splitPathAndPosition } from "./terminal-links";

function normalizePathSeparators(path: string): string {
  return path.replaceAll("\\", "/");
}

function canonicalizeWindowsDrivePath(path: string): string {
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
}

function trimTrailingPathSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function basenameOfPath(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

function stripRelativePrefixes(path: string): string {
  return path.replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function appendPathPosition(
  path: string,
  line: string | undefined,
  column: string | undefined,
): string {
  if (!line) return path;
  return `${path}:${line}${column ? `:${column}` : ""}`;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:\//.test(path);
}

function pathsAreAliases(left: string, right: string): boolean {
  const leftForCompare = left.toLowerCase();
  const rightForCompare = right.toLowerCase();
  if (leftForCompare === rightForCompare) return true;

  const leftIsAbsolute = isAbsolutePath(left);
  const rightIsAbsolute = isAbsolutePath(right);
  if (leftIsAbsolute === rightIsAbsolute) return false;

  const absolutePath = leftIsAbsolute ? leftForCompare : rightForCompare;
  const relativePath = stripRelativePrefixes(leftIsAbsolute ? rightForCompare : leftForCompare);
  return relativePath.length > 0 && absolutePath.endsWith(`/${relativePath}`);
}

export function formatWorkspaceRelativePath(
  pathWithPosition: string,
  workspaceRoot: string | undefined,
): string {
  const { path, line, column } = splitPathAndPosition(pathWithPosition);
  const normalizedPath = canonicalizeWindowsDrivePath(normalizePathSeparators(path));

  let displayPath = normalizedPath;
  if (workspaceRoot) {
    const normalizedWorkspaceRoot = canonicalizeWindowsDrivePath(
      normalizePathSeparators(trimTrailingPathSeparators(workspaceRoot)),
    );
    const workspaceLabel = basenameOfPath(normalizedWorkspaceRoot);
    const pathForCompare = normalizedPath.toLowerCase();
    const workspaceForCompare = normalizedWorkspaceRoot.toLowerCase();
    const workspaceWithSeparator = `${workspaceForCompare}/`;
    const workspaceLabelWithSeparator = `${workspaceLabel.toLowerCase()}/`;

    if (pathForCompare === workspaceForCompare) {
      displayPath = workspaceLabel;
    } else if (pathForCompare.startsWith(workspaceWithSeparator)) {
      const relativeSuffix = normalizedPath.slice(normalizedWorkspaceRoot.length + 1);
      displayPath = `${workspaceLabel}/${relativeSuffix}`;
    } else if (!normalizedPath.startsWith("/")) {
      const relativePath = stripRelativePrefixes(normalizedPath);
      displayPath = pathForCompare.startsWith(workspaceLabelWithSeparator)
        ? normalizedPath
        : `${workspaceLabel}/${relativePath}`;
    }
  }

  return appendPathPosition(displayPath, line, column);
}

export function formatWorkspaceAbsolutePath(
  pathWithPosition: string,
  workspaceRoot: string | undefined,
): string {
  const { path, line, column } = splitPathAndPosition(pathWithPosition);
  const normalizedPath = canonicalizeWindowsDrivePath(normalizePathSeparators(path));
  if (isAbsolutePath(normalizedPath) || !workspaceRoot) {
    return appendPathPosition(normalizedPath, line, column);
  }

  const normalizedWorkspaceRoot = canonicalizeWindowsDrivePath(
    normalizePathSeparators(trimTrailingPathSeparators(workspaceRoot)),
  );
  const relativePath = stripRelativePrefixes(normalizedPath);
  const workspaceLabel = basenameOfPath(normalizedWorkspaceRoot);
  const workspaceParent = normalizedWorkspaceRoot.slice(
    0,
    Math.max(0, normalizedWorkspaceRoot.length - workspaceLabel.length - 1),
  );
  const pathAlreadyIncludesWorkspace =
    relativePath.toLowerCase() === workspaceLabel.toLowerCase() ||
    relativePath.toLowerCase().startsWith(`${workspaceLabel.toLowerCase()}/`);
  const absolutePath = pathAlreadyIncludesWorkspace
    ? `${workspaceParent}/${relativePath}`
    : `${normalizedWorkspaceRoot}/${relativePath}`;

  return appendPathPosition(absolutePath, line, column);
}

export interface ResolvedChangedFilePath {
  displayPath: string;
  fullPath: string;
}

/**
 * Provider lifecycle events may report the same changed file in both absolute
 * and workspace-relative forms. Collapse those aliases while retaining the
 * short form for the row summary and the absolute form for expanded details.
 */
export function resolveChangedFilePaths(
  paths: ReadonlyArray<string>,
  workspaceRoot: string | undefined,
): ResolvedChangedFilePath[] {
  const groups: Array<{
    comparisonPaths: string[];
    displayPaths: string[];
    fullPaths: string[];
    absolutePaths: string[];
  }> = [];

  for (const pathWithPosition of paths) {
    const { path, line, column } = splitPathAndPosition(pathWithPosition);
    const normalizedPath = canonicalizeWindowsDrivePath(normalizePathSeparators(path));
    const fullPath = formatWorkspaceAbsolutePath(pathWithPosition, workspaceRoot);
    const { path: fullPathWithoutPosition } = splitPathAndPosition(fullPath);
    const group = groups.find(({ comparisonPaths }) =>
      comparisonPaths.some(
        (candidate) =>
          pathsAreAliases(candidate, normalizedPath) ||
          pathsAreAliases(candidate, fullPathWithoutPosition),
      ),
    );
    const target =
      group ??
      (() => {
        const created = {
          comparisonPaths: [],
          displayPaths: [],
          fullPaths: [],
          absolutePaths: [],
        };
        groups.push(created);
        return created;
      })();

    target.comparisonPaths.push(normalizedPath, fullPathWithoutPosition);
    target.displayPaths.push(formatWorkspaceRelativePath(pathWithPosition, workspaceRoot));
    target.fullPaths.push(fullPath);
    if (isAbsolutePath(normalizedPath)) {
      target.absolutePaths.push(appendPathPosition(normalizedPath, line, column));
    }
  }

  return groups.map(({ displayPaths, fullPaths, absolutePaths }) => ({
    displayPath: displayPaths.toSorted((left, right) => left.length - right.length)[0]!,
    fullPath: (absolutePaths[0] ?? fullPaths[0])!,
  }));
}
