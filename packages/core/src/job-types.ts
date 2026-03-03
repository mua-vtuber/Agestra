export type JobState =
  | "queued"
  | "running"
  | "completed"
  | "error"
  | "timed_out"
  | "cancelled"
  | "missing_cli";

export interface JobDescriptor {
  id: string;
  provider: string;
  prompt: string;
  timeout: number;
  createdAt: string;
  cliCommand?: string;
  cliArgs?: string[];
}

export interface JobStatus {
  id: string;
  state: JobState;
  provider: string;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number;
}

export interface JobResult {
  id: string;
  state: JobState;
  output?: string;
  error?: string;
  exitCode?: number;
}
