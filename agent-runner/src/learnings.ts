import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Repository "learnings": short, human-curated notes the runner feeds into the
 * task file so each run starts with the institutional knowledge accumulated
 * from previous failures (see docs/learnings.md).
 *
 * Only plain text is read; the file is optional and never written by the
 * pipeline (the weekly retro proposes changes via a normal PR).
 */

export const LEARNINGS_FILE = "docs/learnings.md";

const MAX_SECTION_CHARS = 1200;
const MAX_TOTAL_CHARS = 2400;

export interface Section {
  heading: string;
  body: string;
}

/** Split a markdown document into `## heading` sections. */
export function parseSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let heading = "";
  let lines: string[] = [];

  const flush = () => {
    const body = lines.join("\n").trim();
    if (heading && body) sections.push({ heading, body });
    lines = [];
  };

  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) {
      flush();
      heading = line.slice(3).trim();
      continue;
    }
    if (line.startsWith("# ")) continue; // document title
    if (heading) lines.push(line);
  }
  flush();
  return sections;
}

function score(section: Section, terms: string[]): number {
  const haystack = `${section.heading}\n${section.body}`.toLowerCase();
  let total = 0;
  for (const term of terms) {
    if (term.length < 3) continue;
    if (haystack.includes(term.toLowerCase())) total += 1;
  }
  return total;
}

/**
 * Pick the sections most relevant to an issue. Falls back to the first
 * sections when nothing matches, so a fresh repository still gets context.
 */
export function selectLearnings(markdown: string, query: string, limit = 2): Section[] {
  const sections = parseSections(markdown);
  if (sections.length === 0) return [];

  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_\-\u4e00-\u9fff]+/i)
    .filter(Boolean);

  const ranked = sections
    .map((section, index) => ({ section, index, hits: score(section, terms) }))
    .sort((a, b) => (b.hits - a.hits !== 0 ? b.hits - a.hits : a.index - b.index));

  return ranked.slice(0, limit).map((entry) => entry.section);
}

/** Read the learnings file from a worktree (optional). */
export function readLearnings(workDir: string, file = LEARNINGS_FILE): string {
  const path = join(workDir, file);
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Render the learnings block appended to TASK.md, or "" when there is none. */
export function renderLearnings(workDir: string, query: string, file = LEARNINGS_FILE): string {
  const markdown = readLearnings(workDir, file);
  if (!markdown) return "";

  const picked = selectLearnings(markdown, query);
  if (picked.length === 0) return "";

  const blocks: string[] = [];
  let budget = MAX_TOTAL_CHARS;
  for (const section of picked) {
    if (budget <= 0) break;
    const body = section.body.length > MAX_SECTION_CHARS ? `${section.body.slice(0, MAX_SECTION_CHARS)}…` : section.body;
    const block = `### ${section.heading}\n${body}`;
    blocks.push(block);
    budget -= block.length;
  }
  return [
    ``,
    `---`,
    ``,
    `## 仓库经验（来自 ${file}，仅作提示）`,
    ``,
    blocks.join("\n\n"),
    ``,
  ].join("\n");
}
