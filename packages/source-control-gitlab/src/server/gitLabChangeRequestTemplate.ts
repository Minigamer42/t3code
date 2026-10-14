import type { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

const TEMPLATE_MAX_BYTES = 8_000;
const TREE_LIST_MAX_BYTES = 100_000;
const TRUNCATION_MARKER = "[truncated]";

const GITLAB_TEMPLATE_PATHS = [
  ".gitlab/merge_request_templates/Default.md",
  ".gitlab/merge_request_templates/default.md",
  ".gitlab/merge_request_templates/DEFAULT.md",
] as const;

type ExecuteGit = SourceControlHost.SourceControlHost["Service"]["git"]["execute"];

interface TemplateTreeEntry {
  readonly objectId: string;
  readonly path: string;
}

function parseTemplateTreeEntries(output: string): ReadonlyArray<TemplateTreeEntry> {
  const entries: TemplateTreeEntry[] = [];
  for (const record of output.split("\0")) {
    if (record.length === 0) {
      continue;
    }

    const separator = record.indexOf("\t");
    if (separator < 0) {
      continue;
    }

    const [mode, type, objectId] = record.slice(0, separator).split(" ");
    if (
      type !== "blob" ||
      (mode !== "100644" && mode !== "100755") ||
      !objectId ||
      !/^[0-9a-f]{40,64}$/.test(objectId)
    ) {
      continue;
    }

    entries.push({ objectId, path: record.slice(separator + 1) });
  }
  return entries;
}

function readTemplateBlob(input: {
  readonly cwd: string;
  readonly executeGit: ExecuteGit;
  readonly entry: TemplateTreeEntry;
}): Effect.Effect<Option.Option<string>, GitCommandError> {
  return input
    .executeGit({
      operation: "gitLabChangeRequestTemplate.readTemplateBlob",
      cwd: input.cwd,
      args: ["cat-file", "blob", input.entry.objectId],
      maxOutputBytes: TEMPLATE_MAX_BYTES,
      appendTruncationMarker: true,
    })
    .pipe(
      Effect.map((result) => {
        const template = result.stdout.trim();
        if (template.length === 0) {
          return Option.none();
        }
        return Option.some(
          result.stdoutTruncated && !template.endsWith(TRUNCATION_MARKER)
            ? `${template}\n\n${TRUNCATION_MARKER}`
            : template,
        );
      }),
    );
}

export const detect = Effect.fn("detect")(function* (
  cwd: string,
  treeish: string,
  executeGit: ExecuteGit,
) {
  return yield* Effect.gen(function* () {
    const result = yield* executeGit({
      operation: "gitLabChangeRequestTemplate.listTemplates",
      cwd,
      args: ["ls-tree", "-r", "-z", "--full-tree", treeish, "--", ...GITLAB_TEMPLATE_PATHS],
      maxOutputBytes: TREE_LIST_MAX_BYTES,
      appendTruncationMarker: true,
    });
    if (result.stdoutTruncated) {
      return Option.none();
    }

    const entriesByPath = new Map(
      parseTemplateTreeEntries(result.stdout).map((entry) => [entry.path, entry]),
    );
    for (const templatePath of GITLAB_TEMPLATE_PATHS) {
      const entry = entriesByPath.get(templatePath);
      if (!entry) {
        continue;
      }
      const template = yield* readTemplateBlob({ cwd, executeGit, entry });
      if (Option.isSome(template)) {
        return template;
      }
    }

    return Option.none();
  }).pipe(Effect.orElseSucceed(() => Option.none()));
});
