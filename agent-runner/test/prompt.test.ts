import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import {
  DEFAULT_LOCALE,
  TASK_KINDS,
  loadTemplate,
  normalizeLocale,
  normalizePromptsDir,
  renderTaskMarkdown,
  templateCandidates,
} from "../src/prompt.ts";

const promptsRoot = new URL("../prompts/", import.meta.url);

describe("locale and promptsDir normalisation", () => {
  it("accepts language tags and normalises case and underscores", () => {
    assert.equal(normalizeLocale("zh-CN"), "zh-cn");
    assert.equal(normalizeLocale("zh_CN"), "zh-cn");
    assert.equal(normalizeLocale(" en "), "en");
    assert.equal(normalizeLocale("pt-br"), "pt-br");
  });

  it("rejects anything that is not a language tag", () => {
    for (const bad of ["../secrets", "zh/cn", ".", "", "   ", "en-US-x", "a/b"]) {
      assert.equal(normalizeLocale(bad), undefined, bad);
    }
  });

  it("accepts nested prompt directories but not traversal", () => {
    assert.equal(normalizePromptsDir("swift"), "swift");
    assert.equal(normalizePromptsDir("mobile/swift/"), "mobile/swift");
    for (const bad of ["../x", "/abs", "a/../b", "a//b", ".."]) {
      assert.equal(normalizePromptsDir(bad), undefined, bad);
    }
  });
});

describe("template resolution", () => {
  it("falls back to the english template when the locale is unknown", () => {
    assert.deepEqual(templateCandidates("bug-fix", { locale: "de" }), ["de/bug-fix.md", "bug-fix.md"]);
    assert.equal(loadTemplate("bug-fix", { locale: "de" }).label, "bug-fix.md");
  });

  it("prefers repository variants, most specific first", () => {
    assert.deepEqual(templateCandidates("feature", { locale: "zh-cn", promptsDir: "swift" }), [
      "swift/zh-cn/feature.md",
      "swift/feature.md",
      "zh-cn/feature.md",
      "feature.md",
    ]);
    assert.deepEqual(templateCandidates("feature", { promptsDir: "swift" }), [
      "swift/feature.md",
      "feature.md",
    ]);
  });

  it("does not repeat the default locale", () => {
    assert.deepEqual(templateCandidates("review", { locale: "en" }), ["review.md"]);
    assert.deepEqual(templateCandidates("review", { locale: DEFAULT_LOCALE, promptsDir: "strict" }), [
      "strict/review.md",
      "review.md",
    ]);
  });

  it("ships a zh-cn variant for every task kind", () => {
    for (const kind of TASK_KINDS) {
      assert.ok(existsSync(new URL(`zh-cn/${kind}.md`, promptsRoot)), `missing zh-cn/${kind}.md`);
      assert.equal(loadTemplate(kind, { locale: "zh-cn" }).label, `zh-cn/${kind}.md`);
    }
  });
});

const meta = {
  repo: "owner/repo",
  issueNumber: 7,
  title: "Title",
  url: "https://example.test/issues/7",
  labels: ["ai"],
  branch: "ai/issue-7",
  provider: "deepseek",
  model: "model",
};

describe("renderTaskMarkdown", () => {
  it("substitutes every token in both languages", () => {
    for (const locale of ["en", "zh-cn"]) {
      const out = renderTaskMarkdown("bug-fix", meta, "BODY", { locale });
      for (const expected of ["owner/repo", "#7", "ai/issue-7", "BODY"]) {
        assert.ok(out.includes(expected), `${locale} is missing ${expected}`);
      }
      assert.equal(/\{\{(?:repo|issue_number|title|url|labels|branch|provider|model|body)\}\}/.test(out), false);
    }
  });

  it("keeps the token set identical across languages", () => {
    const tokens = (text: string) => [...new Set(text.match(/\{\{[a-z_]+\}\}/g) ?? [])].sort();
    for (const kind of TASK_KINDS) {
      const en = tokens(readFileSync(new URL(`${kind}.md`, promptsRoot), "utf8"));
      const zh = tokens(readFileSync(new URL(`zh-cn/${kind}.md`, promptsRoot), "utf8"));
      assert.deepEqual(zh, en, `token drift in zh-cn/${kind}.md`);
    }
  });

  it("renders the requested language", () => {
    assert.ok(renderTaskMarkdown("feature", meta, "BODY", { locale: "zh-cn" }).includes("工作规则"));
    assert.ok(renderTaskMarkdown("feature", meta, "BODY").includes("Working rules"));
  });

  it("routes every kind through the classifier", () => {
    const issue = (labels: string[], title = "fix a crash") => ({
      number: 1,
      title,
      body: "",
      url: "",
      labels,
    });
    assert.equal(loadTemplate("review", { locale: "zh-cn" }).label, "zh-cn/review.md");
    assert.equal(issue(["ai"]).title, "fix a crash");
  });
});
