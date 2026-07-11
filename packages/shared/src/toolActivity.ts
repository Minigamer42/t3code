import type { RuntimeItemStatus, ToolLifecycleItemType } from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeCommandValue(value: unknown): string | undefined {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const entry of value) {
    const part = asTrimmedString(entry);
    if (part !== undefined) {
      parts.push(part);
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function stripTrailingExitCode(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code \d+>)\s*$/iu.exec(trimmed);
  const output = match?.groups?.output?.trim() ?? trimmed;
  return output.length > 0 ? output : undefined;
}

function extractCommandFromTitle(title: string | undefined): string | undefined {
  if (!title) {
    return undefined;
  }
  const backtickMatch = /`([^`]+)`/u.exec(title);
  return backtickMatch?.[1]?.trim() || undefined;
}

function extractToolCommand(data: Record<string, unknown> | undefined, title: string | undefined) {
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const itemResult = asRecord(item?.result);
  const rawInput = asRecord(data?.rawInput);
  const candidates = [
    normalizeCommandValue(item?.command),
    normalizeCommandValue(itemInput?.command),
    normalizeCommandValue(itemResult?.command),
    normalizeCommandValue(data?.command),
    normalizeCommandValue(rawInput?.command),
  ];
  const direct = candidates.find((candidate) => candidate !== undefined);
  if (direct) {
    return direct;
  }
  const executable = asTrimmedString(rawInput?.executable);
  const args = normalizeCommandValue(rawInput?.args);
  if (executable && args) {
    return `${executable} ${args}`;
  }
  if (executable) {
    return executable;
  }
  return extractCommandFromTitle(title);
}

function maybePathLike(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (
    value.includes("/") ||
    value.includes("\\") ||
    value.startsWith(".") ||
    /\.(?:[a-z0-9]{1,12})$/iu.test(value)
  ) {
    return value;
  }
  return undefined;
}

function collectPaths(value: unknown, paths: string[], seen: Set<string>, depth: number): void {
  if (depth > 4 || paths.length >= 8) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPaths(entry, paths, seen, depth + 1);
      if (paths.length >= 8) {
        return;
      }
    }
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }
  for (const key of [
    "path",
    "filePath",
    "file_path",
    "relativePath",
    "filename",
    "newPath",
    "oldPath",
  ]) {
    const candidate = maybePathLike(asTrimmedString(record[key]));
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    paths.push(candidate);
    if (paths.length >= 8) {
      return;
    }
  }
  for (const nestedKey of ["locations", "item", "input", "result", "rawInput", "data", "changes"]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectPaths(record[nestedKey], paths, seen, depth + 1);
    if (paths.length >= 8) {
      return;
    }
  }
}

function normalizeStringList(value: unknown): string | undefined {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== undefined);
  return values.length > 0 ? values.join(", ") : undefined;
}

function extractSearchDetail(data: Record<string, unknown> | undefined): string | undefined {
  const item = asRecord(data?.item);
  const action = asRecord(item?.action);
  const rawInput = asRecord(data?.rawInput);
  const input = asRecord(data?.input);
  const actionType = asTrimmedString(action?.type);

  if (actionType === "findInPage") {
    const pattern = asTrimmedString(action?.pattern);
    const url = asTrimmedString(action?.url);
    if (pattern && url) {
      return `${pattern} in ${url}`;
    }
    return pattern ?? url;
  }
  if (actionType === "openPage") {
    return asTrimmedString(action?.url);
  }

  const candidates = [
    action?.queries,
    action?.query,
    item?.query,
    rawInput?.query,
    rawInput?.queries,
    rawInput?.pattern,
    rawInput?.searchTerm,
    rawInput?.url,
    input?.query,
    input?.queries,
    input?.pattern,
    input?.searchTerm,
    input?.url,
  ];
  return candidates.map(normalizeStringList).find((candidate) => candidate !== undefined);
}

function extractPrimaryPath(data: Record<string, unknown> | undefined): string | undefined {
  const paths: string[] = [];
  collectPaths(data, paths, new Set<string>(), 0);
  return paths[0];
}

function normalizeEquivalentValue(value: string | undefined): string | undefined {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/\s+/gu, " ")
    .replace(/\s+(?:complete|completed|started)\s*$/iu, "")
    .trim();
}

function isEquivalent(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeEquivalentValue(left)?.toLowerCase();
  const normalizedRight = normalizeEquivalentValue(right)?.toLowerCase();
  return normalizedLeft !== undefined && normalizedLeft === normalizedRight;
}

function classifyToolAction(input: {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly title?: string | undefined;
  readonly data?: Record<string, unknown> | undefined;
}): "command" | "read" | "file_change" | "file_search" | "web_search" | "image_view" | "other" {
  const itemType = input.itemType ?? undefined;
  const kind = asTrimmedString(input.data?.kind)?.toLowerCase();
  const title = asTrimmedString(input.title)?.toLowerCase();
  if (itemType === "command_execution" || kind === "execute" || title === "terminal") {
    return "command";
  }
  if (kind === "read" || title === "read file") {
    return "read";
  }
  if (
    itemType === "file_change" ||
    kind === "edit" ||
    kind === "move" ||
    kind === "delete" ||
    kind === "write"
  ) {
    return "file_change";
  }
  if (itemType === "web_search") {
    return "web_search";
  }
  if (itemType === "image_view") {
    return "image_view";
  }
  if (kind === "search" || title === "find" || title === "grep") {
    return "file_search";
  }
  return "other";
}

function lifecyclePhase(input: {
  readonly status?: RuntimeItemStatus | null | undefined;
  readonly lifecycle?: "started" | "updated" | "completed" | null | undefined;
}): "inProgress" | "completed" | "failed" | "declined" {
  if (input.status === "failed") return "failed";
  if (input.status === "declined") return "declined";
  if (input.status === "inProgress") return "inProgress";
  if (input.lifecycle === "started" || input.lifecycle === "updated") return "inProgress";
  return "completed";
}

function lifecycleSummary(input: {
  readonly action: ReturnType<typeof classifyToolAction>;
  readonly phase: ReturnType<typeof lifecyclePhase>;
  readonly fallbackSummary: string;
  readonly title: string | undefined;
}): string | undefined {
  const fallback = input.title ?? input.fallbackSummary;
  if (input.phase === "failed") {
    switch (input.action) {
      case "command":
        return "Command failed";
      case "read":
        return "Read failed";
      case "file_change":
        return "File change failed";
      case "file_search":
        return "File search failed";
      case "web_search":
        return "Web search failed";
      case "image_view":
        return "Image view failed";
      case "other":
        return fallback === "Tool" ? "Tool failed" : `${fallback} failed`;
    }
  }
  if (input.phase === "declined") {
    return fallback === "Tool" ? "Tool declined" : `${fallback} declined`;
  }
  const completed = input.phase === "completed";
  switch (input.action) {
    case "command":
      return completed ? "Ran command" : "Running command";
    case "read":
      return completed ? "Read file" : "Reading file";
    case "file_change":
      return completed ? "Changed files" : "Editing files";
    case "file_search":
      return completed ? "Searched files" : "Searching files";
    case "web_search":
      return completed ? "Searched web" : "Searching web";
    case "image_view":
      return completed ? "Viewed image" : "Viewing image";
    case "other":
      return undefined;
  }
}

export interface ToolActivityPresentationInput {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly status?: RuntimeItemStatus | null | undefined;
  readonly lifecycle?: "started" | "updated" | "completed" | null | undefined;
  readonly title?: string | null | undefined;
  readonly detail?: string | null | undefined;
  readonly data?: unknown;
  readonly fallbackSummary?: string | null | undefined;
}

export interface ToolActivityPresentation {
  readonly summary: string;
  readonly detail?: string | undefined;
}

export function deriveToolActivityPresentation(
  input: ToolActivityPresentationInput,
): ToolActivityPresentation {
  const title = asTrimmedString(input.title);
  const detail = stripTrailingExitCode(asTrimmedString(input.detail));
  const fallbackSummary = asTrimmedString(input.fallbackSummary) ?? "Tool";
  const data = asRecord(input.data);
  const command = extractToolCommand(data, title);
  const primaryPath = extractPrimaryPath(data);
  const action = classifyToolAction({
    itemType: input.itemType,
    title,
    data,
  });
  const phase = lifecyclePhase({
    status: input.status,
    lifecycle: input.lifecycle,
  });
  const summary = lifecycleSummary({
    action,
    phase,
    fallbackSummary,
    title,
  });

  if (action === "command") {
    return {
      summary: summary ?? fallbackSummary,
      ...(command ? { detail: command } : {}),
    };
  }

  if (action === "read") {
    if (primaryPath) {
      return {
        summary: summary ?? fallbackSummary,
        detail: primaryPath,
      };
    }
    return {
      summary: summary ?? fallbackSummary,
    };
  }

  if (action === "file_change") {
    return {
      summary: summary ?? fallbackSummary,
      ...(primaryPath ? { detail: primaryPath } : {}),
    };
  }

  if (action === "file_search" || action === "web_search") {
    const query = extractSearchDetail(data);
    return {
      summary: summary ?? fallbackSummary,
      ...(query ? { detail: query } : {}),
    };
  }

  if (action === "image_view") {
    return {
      summary: summary ?? fallbackSummary,
      ...(primaryPath ? { detail: primaryPath } : {}),
    };
  }

  if (detail && !isEquivalent(detail, title) && !isEquivalent(detail, fallbackSummary)) {
    return {
      summary: summary ?? title ?? fallbackSummary,
      detail,
    };
  }

  return {
    summary: summary ?? title ?? fallbackSummary,
  };
}
