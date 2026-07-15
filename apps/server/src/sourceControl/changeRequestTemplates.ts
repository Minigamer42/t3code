import type { SourceControlProviderKind } from "@t3tools/contracts";

const GITHUB_DEFAULT_TEMPLATE_PATHS = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
] as const;

const GITLAB_DEFAULT_TEMPLATE_PATHS = [
  ".gitlab/merge_request_templates/Default.md",
  ".gitlab/merge_request_templates/default.md",
  ".gitlab/merge_request_templates/DEFAULT.md",
] as const;

export function defaultChangeRequestTemplatePaths(
  provider: SourceControlProviderKind,
): ReadonlyArray<string> {
  switch (provider) {
    case "github":
      return GITHUB_DEFAULT_TEMPLATE_PATHS;
    case "gitlab":
      return GITLAB_DEFAULT_TEMPLATE_PATHS;
    case "azure-devops":
    case "bitbucket":
    case "unknown":
      return [];
  }
}
