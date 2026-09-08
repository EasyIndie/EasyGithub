import type { IssueInfo } from "./github.ts";

export type TaskKind = "bug-fix" | "feature" | "review";

/** V0.1 routing: choose a prompt template from labels / title keywords. */
export function classifyTask(issue: IssueInfo): TaskKind {
  const labels = issue.labels.join(" ").toLowerCase();
  const title = issue.title.toLowerCase();
  if (labels.includes("review")) return "review";
  if (labels.includes("feature") || /\b(feat|feature|add|implement|improve|support|enhancement)\b/.test(title)) {
    return "feature";
  }
  return "bug-fix";
}

export interface TaskMeta {
  repo: string;
  issueNumber: number;
  title: string;
  url: string;
  labels: string[];
  branch: string;
  provider: string;
  model: string;
}

const TOKENS = ["repo", "issue_number", "title", "url", "labels", "branch", "provider", "model"] as const;

export async function renderTaskMarkdown(kind: TaskKind, meta: TaskMeta, body: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const dir = new URL("../prompts/", import.meta.url);
  const template = await readFile(new URL(`${kind}.md`, dir), "utf8");

  const replacements: Record<string, string> = {
    repo: meta.repo,
    issue_number: String(meta.issueNumber),
    title: meta.title,
    url: meta.url,
    labels: meta.labels.join(", ") || "(none)",
    branch: meta.branch,
    provider: meta.provider,
    model: meta.model,
  };

  let out = template;
  for (const t of TOKENS) {
    out = out.split(`{{${t}}}`).join(replacements[t]);
  }
  out = out.split("{{body}}").join(body || "(empty issue body)");
  return out;
}
