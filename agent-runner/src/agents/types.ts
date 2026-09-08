export interface CodingAgent {
  name: string;
  run(req: AgentRequest): Promise<AgentResult>;
}

export interface AgentRequest {
  /** owner/name of the repository */
  repo: string;
  issueNumber: number;
  /** directory where the task branch is checked out (agent cwd) */
  workDir: string;
  /** absolute path of the rendered task markdown file */
  taskFile: string;
  provider: string;
  model: string;
  /** extra CLI args passed to the agent binary, e.g. ["--thinking","medium"] */
  extraArgs: string[];
  /** absolute path of the run log file */
  logFile: string;
  /** ms before the agent run is killed */
  timeoutMs: number;
  /** provider env already available in process.env (e.g. DEEPSEEK_API_KEY) */
  env: NodeJS.ProcessEnv;
}

export interface AgentResult {
  ok: boolean;
  /** short summary of what happened; used in PR body / issue comment */
  summary: string;
  /** full plain-text log location (may be absent) */
  logFile?: string;
  /** detail message on failure */
  error?: string;
}
