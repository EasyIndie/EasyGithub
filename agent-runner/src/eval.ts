import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { selectAgent } from "./agents/registry.ts";
import { agentEnv } from "./env.ts";
import { classifyTask, renderTaskMarkdown } from "./prompt.ts";
import { runAsync, runSync } from "./util/exec.ts";

/**
 * Frozen-task evaluation harness.
 *
 * "Eval as spec": prompt/model/router changes are only defensible if they can
 * be measured. Each task pins a repository + commit + issue, keeps its tests
 * HIDDEN from the agent (written only after the agent exits), and reports
 * pass@1 / duration / cost-proxy.
 *
 * Usage:
 *   node agent-runner/src/eval.ts --list
 *   node agent-runner/src/eval.ts --dry-run
 *   node agent-runner/src/eval.ts --task example-sum --agent pi --model deepseek-v4-flash
 *
 * Requires network + the provider key; not part of PR CI.
 */

export interface EvalTask {
  id: string;
  repo: string;
  baseCommit?: string;
  issue: { title: string; body: string; labels?: string[] };
  /** command run AFTER the hidden files are in place */
  verifyCmd: string;
  hidden: Array<{ path: string; content: string }>;
  timeoutMs?: number;
  enabled?: boolean;
}

export interface TaskResult {
  id: string;
  ok: boolean;
  stage: "clone" | "agent" | "verify" | "done" | "skipped";
  detail: string;
  durationMs: number;
  agentLog?: string;
}

const TASKS_DIR = new URL("../../eval/tasks/", import.meta.url);

export function loadTasks(): EvalTask[] {
  const dir = TASKS_DIR.pathname;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as EvalTask)
    .filter((t) => t.enabled !== false);
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runTask(task: EvalTask, opts: { agent: string; model: string; keep: boolean }): Promise<TaskResult> {
  const startedAt = Date.now();
  const workDir = mkdtempSync(join(tmpdir(), `easygh-eval-${task.id}-`));
  const cleanup = () => {
    if (!opts.keep) rmSync(workDir, { recursive: true, force: true });
  };

  try {
    const clone = runSync("git", ["clone", "--quiet", `https://github.com/${task.repo}.git`, workDir]);
    if (clone.status !== 0) {
      return { id: task.id, ok: false, stage: "clone", detail: clone.stderr.slice(0, 500), durationMs: Date.now() - startedAt };
    }
    if (task.baseCommit) {
      const checkout = runSync("git", ["checkout", "--quiet", task.baseCommit], { cwd: workDir });
      if (checkout.status !== 0) {
        return { id: task.id, ok: false, stage: "clone", detail: checkout.stderr.slice(0, 500), durationMs: Date.now() - startedAt };
      }
    }

    const issue = {
      number: 0,
      title: task.issue.title,
      body: task.issue.body,
      url: `https://github.com/${task.repo}/issues/0`,
      labels: task.issue.labels ?? [],
    };
    const kind = classifyTask(issue);
    const meta = {
      repo: task.repo,
      issueNumber: 0,
      title: issue.title,
      url: issue.url,
      labels: issue.labels,
      branch: "eval",
      provider: "eval",
      model: opts.model,
    };
    const taskFile = join(workDir, ".eval-task.md");
    writeFileSync(taskFile, await renderTaskMarkdown(kind, meta, issue.body));

    const agent = selectAgent(opts.agent);
    const agentLog = join(workDir, ".eval-agent.log");
    const agentResult = await agent.run({
      repo: task.repo,
      issueNumber: 0,
      workDir,
      taskFile,
      provider: "deepseek",
      model: opts.model,
      extraArgs: [],
      logFile: agentLog,
      timeoutMs: task.timeoutMs ?? 15 * 60 * 1000,
      env: agentEnv(),
    });
    if (!agentResult.ok) {
      return {
        id: task.id,
        ok: false,
        stage: "agent",
        detail: agentResult.error ?? "agent failed",
        durationMs: Date.now() - startedAt,
        ...(opts.keep ? { agentLog } : {}),
      };
    }

    // Hidden tests are only materialised after the agent is done: the agent
    // must not be able to read (or optimise against) the acceptance criteria.
    for (const hidden of task.hidden) {
      const target = join(workDir, hidden.path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, hidden.content);
    }

    let output = "";
    const verify = await runAsync("bash", ["-c", task.verifyCmd], {
      cwd: workDir,
      timeoutMs: task.timeoutMs ?? 10 * 60 * 1000,
      onStdout: (s) => (output += s),
      onStderr: (s) => (output += s),
    });

    return {
      id: task.id,
      ok: verify.ok,
      stage: verify.ok ? "done" : "verify",
      detail: output.trim().slice(-1500),
      durationMs: Date.now() - startedAt,
      ...(opts.keep ? { agentLog } : {}),
    };
  } finally {
    cleanup();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback: string): string => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? (args[index + 1] as string) : fallback;
  };
  const tasks = loadTasks();

  if (args.includes("--list")) {
    for (const task of tasks) console.log(`${task.id}\t${task.repo}\t${task.verifyCmd}`);
    return;
  }
  if (args.includes("--dry-run")) {
    let bad = 0;
    for (const task of tasks) {
      const problems: string[] = [];
      if (!task.id) problems.push("missing id");
      if (!/^[\w.-]+\/[\w.-]+$/.test(task.repo ?? "")) problems.push("bad repo");
      if (!task.verifyCmd) problems.push("missing verifyCmd");
      if (!Array.isArray(task.hidden) || task.hidden.length === 0) problems.push("missing hidden tests");
      console.log(`${problems.length === 0 ? "ok  " : "FAIL"} ${task.id}: ${problems.join(", ") || "valid"}`);
      if (problems.length > 0) bad++;
    }
    process.exitCode = bad === 0 ? 0 : 1;
    return;
  }

  const only = flag("task", "");
  const agent = flag("agent", "pi");
  const model = flag("model", process.env.MODEL ?? "deepseek-v4-flash");
  const keep = args.includes("--keep");
  const selected = only ? tasks.filter((t) => t.id === only) : tasks;
  if (selected.length === 0) {
    console.error(`no task matched${only ? ` --task ${only}` : ""}`);
    process.exitCode = 1;
    return;
  }

  const results: TaskResult[] = [];
  for (const task of selected) {
    console.log(`\n=== eval ${task.id} (${task.repo}) ===`);
    const result = await runTask(task, { agent, model, keep });
    results.push(result);
    console.log(`${result.ok ? "PASS" : "FAIL"} ${result.id} stage=${result.stage} ${Math.round(result.durationMs / 1000)}s`);
    if (!result.ok) console.log(result.detail.slice(0, 800));
  }

  const passed = results.filter((r) => r.ok).length;
  const summary = {
    at: new Date().toISOString(),
    agent,
    model,
    total: results.length,
    passed,
    passAt1: results.length === 0 ? 0 : passed / results.length,
    results,
  };
  const outDir = resolve(flag("out", "eval/results"));
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${summary.at.replace(/[:.]/g, "-")}.json`);
  writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\npass@1 = ${passed}/${results.length} (${(summary.passAt1 * 100).toFixed(0)}%) -> ${outFile}`);
  process.exitCode = passed === results.length ? 0 : 1;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error("[eval] fatal:", err);
    process.exitCode = 1;
  });
}
