import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { IssueInfo } from "./github.ts";

export type TaskKind = "bug-fix" | "feature" | "review";

export const DEFAULT_LOCALE = "en";
export const TASK_KINDS: TaskKind[] = ["bug-fix", "feature", "review"];

const PROMPTS_DIR_URL = new URL("../prompts/", import.meta.url);

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

/**
 * `zh-CN` / `zh_CN` / `ZH-cn` -> `zh-cn`.
 * Anything that could escape the prompts directory (slashes, dots, spaces) is
 * rejected instead of being used as a path segment.
 */
export function normalizeLocale(raw?: string): string | undefined {
  const value = (raw ?? "").trim().replace(/_/g, "-");
  if (!value) return undefined;
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(value)) return undefined;
  return value.toLowerCase();
}

/** Sub-directory of `agent-runner/prompts/`, e.g. "swift" or "mobile/swift". */
export function normalizePromptsDir(raw?: string): string | undefined {
  const value = (raw ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!value) return undefined;
  if (!/^[a-z0-9._-]+(?:\/[a-z0-9._-]+)*$/i.test(value)) return undefined;
  if (value.split("/").some((segment) => segment === "." || segment === "..")) return undefined;
  return value;
}

export interface TemplateOptions {
  /** requested language; unknown locales fall back to `en` */
  locale?: string;
  /** repository-specific template directory (overrides the shared ones) */
  promptsDir?: string;
}

export interface LoadedTemplate {
  text: string;
  /** path relative to agent-runner/prompts/ */
  label: string;
}

/**
 * Resolution order (first existing file wins):
 *   1. <promptsDir>/<locale>/<kind>.md   repository variant, requested language
 *   2. <promptsDir>/<kind>.md            repository variant, default language
 *   3. <locale>/<kind>.md                shared, requested language
 *   4. <kind>.md                         shared, default language (always present)
 */
export function templateCandidates(kind: TaskKind, options: TemplateOptions = {}): string[] {
  const locale = normalizeLocale(options.locale);
  const dir = normalizePromptsDir(options.promptsDir);
  const candidates: string[] = [];
  const push = (path: string) => {
    if (!candidates.includes(path)) candidates.push(path);
  };

  if (dir && locale && locale !== DEFAULT_LOCALE) push(`${dir}/${locale}/${kind}.md`);
  if (dir) push(`${dir}/${kind}.md`);
  if (locale && locale !== DEFAULT_LOCALE) push(`${locale}/${kind}.md`);
  push(`${kind}.md`);
  return candidates;
}

/** Read the most specific template for `kind`, or throw with the paths tried. */
export function loadTemplate(kind: TaskKind, options: TemplateOptions = {}): LoadedTemplate {
  const tried = templateCandidates(kind, options);
  for (const label of tried) {
    const file = fileURLToPath(new URL(label, PROMPTS_DIR_URL));
    if (existsSync(file)) return { text: readFileSync(file, "utf8"), label };
  }
  throw new Error(`No prompt template for "${kind}" (tried: ${tried.join(", ")})`);
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

export function renderTaskMarkdown(
  kind: TaskKind,
  meta: TaskMeta,
  body: string,
  options: TemplateOptions = {},
): string {
  const template = loadTemplate(kind, options).text;

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
