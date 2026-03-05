import { randomUUID } from "crypto";
import type { ProviderRegistry, JobManager, AIProvider } from "@agestra/core";
import type { AgentLoopFactory } from "./agent-loop.js";
import type { AgentLoopResult } from "./agent-loop.js";

export interface TaskAssignment {
  id?: string;
  providerId: string;
  task: string;
  files?: string[];
  dependsOn?: string[];
}

export interface DispatchConfig {
  assignments: TaskAssignment[];
  mergeStrategy: "concatenate" | "summarize" | "debate";
  validator?: AIProvider;
  timeoutMs?: number;
}

export interface DispatchResult {
  results: {
    assignmentId: string;
    providerId: string;
    output: string;
    status: "completed" | "error" | "timed_out";
  }[];
  mergedOutput?: string;
}

const POLL_INTERVAL = 1_000;

export class TaskDispatcher {
  constructor(
    private registry: ProviderRegistry,
    private jobManager: JobManager,
    private agentLoopFactory?: AgentLoopFactory,
  ) {}

  async dispatch(config: DispatchConfig): Promise<DispatchResult> {
    const startTime = Date.now();
    const timeoutMs = config.timeoutMs ?? 600_000;

    const assignments = config.assignments.map((a) => ({
      ...a,
      id: a.id ?? randomUUID(),
    }));

    // Build dependency graph: assignmentId -> set of dependency IDs
    const pending = new Map<string, Set<string>>();
    for (const a of assignments) {
      pending.set(a.id!, new Set(a.dependsOn ?? []));
    }

    const assignmentById = new Map(assignments.map((a) => [a.id!, a]));
    const completed = new Set<string>();
    const results: DispatchResult["results"] = [];

    while (completed.size < assignments.length) {
      // Check global timeout
      if (Date.now() - startTime > timeoutMs) {
        // Mark remaining as timed_out
        for (const [id] of pending) {
          if (!completed.has(id)) {
            results.push({
              assignmentId: id,
              providerId: assignmentById.get(id)!.providerId,
              output: "",
              status: "timed_out",
            });
            completed.add(id);
          }
        }
        break;
      }

      // Find assignments whose dependencies are all completed
      const ready: (TaskAssignment & { id: string })[] = [];
      for (const [id, deps] of pending) {
        if (completed.has(id)) continue;
        const unmet = [...deps].filter((d) => !completed.has(d));
        if (unmet.length === 0) {
          ready.push(assignmentById.get(id)! as TaskAssignment & { id: string });
        }
      }

      if (ready.length === 0 && completed.size < assignments.length) {
        // Circular dependency or missing dependency — break to avoid infinite loop
        for (const [id] of pending) {
          if (!completed.has(id)) {
            results.push({
              assignmentId: id,
              providerId: assignmentById.get(id)!.providerId,
              output: "",
              status: "error",
            });
            completed.add(id);
          }
        }
        break;
      }

      // Submit all ready assignments in parallel
      const jobMap = new Map<string, string>(); // assignmentId -> jobId
      const loopPromises = new Map<string, Promise<AgentLoopResult>>(); // assignmentId -> AgentLoop promise

      for (const a of ready) {
        // Route tool-tier providers through AgentLoop
        if (this.agentLoopFactory) {
          const loop = this.agentLoopFactory.create(a.providerId);
          if (loop) {
            loopPromises.set(a.id, loop.run(a.task));
            continue;
          }
        }

        // Default: CLI job submission (agent-tier or no factory)
        const jobId = this.jobManager.submit({
          provider: a.providerId,
          prompt: a.task,
        });
        jobMap.set(a.id, jobId);
      }

      // Await AgentLoop results
      if (loopPromises.size > 0) {
        const entries = [...loopPromises.entries()];
        const settled = await Promise.allSettled(entries.map(([, p]) => p));

        for (let i = 0; i < entries.length; i++) {
          const [assignmentId] = entries[i];
          const settlement = settled[i];

          if (settlement.status === "fulfilled") {
            const loopResult = settlement.value;
            results.push({
              assignmentId,
              providerId: assignmentById.get(assignmentId)!.providerId,
              output: loopResult.output,
              status: loopResult.success ? "completed" : "error",
            });
          } else {
            results.push({
              assignmentId,
              providerId: assignmentById.get(assignmentId)!.providerId,
              output: settlement.reason?.message ?? "AgentLoop failed",
              status: "error",
            });
          }
          completed.add(assignmentId);
        }
      }

      // Poll until all submitted CLI jobs finish
      await this.pollJobs(jobMap, results, assignmentById, completed, startTime, timeoutMs);
    }

    const mergedOutput = await this.mergeResults(results, config);

    return { results, mergedOutput };
  }

  private async pollJobs(
    jobMap: Map<string, string>,
    results: DispatchResult["results"],
    assignmentById: Map<string, TaskAssignment & { id?: string }>,
    completed: Set<string>,
    startTime?: number,
    timeoutMs?: number,
  ): Promise<void> {
    const remaining = new Set(jobMap.keys());
    let lastProgressLog = Date.now();

    while (remaining.size > 0) {
      for (const assignmentId of [...remaining]) {
        const jobId = jobMap.get(assignmentId)!;
        const jobResult = this.jobManager.getResult(jobId);

        if (!jobResult) continue;

        const state = jobResult.state;
        if (state === "completed" || state === "error" || state === "timed_out") {
          const status =
            state === "completed"
              ? "completed"
              : state === "timed_out"
                ? "timed_out"
                : "error";

          results.push({
            assignmentId,
            providerId: assignmentById.get(assignmentId)!.providerId,
            output: jobResult.output ?? jobResult.error ?? "",
            status: status as "completed" | "error" | "timed_out",
          });
          completed.add(assignmentId);
          remaining.delete(assignmentId);
        }
      }

      // Progress log every 2 minutes
      if (Date.now() - lastProgressLog > 120_000) {
        console.warn(`[dispatcher] Polling: ${remaining.size} jobs remaining, ${Math.round((Date.now() - (startTime ?? Date.now())) / 1000)}s elapsed`);
        lastProgressLog = Date.now();
      }

      // Check timeout
      if (startTime && timeoutMs && Date.now() - startTime > timeoutMs) {
        for (const assignmentId of [...remaining]) {
          results.push({
            assignmentId,
            providerId: assignmentById.get(assignmentId)!.providerId,
            output: "",
            status: "timed_out",
          });
          completed.add(assignmentId);
          remaining.delete(assignmentId);
        }
        break;
      }

      if (remaining.size > 0) {
        await this.sleep(POLL_INTERVAL);
      }
    }
  }

  private async mergeResults(
    results: DispatchResult["results"],
    config: DispatchConfig,
  ): Promise<string | undefined> {
    if (results.length === 0) return undefined;

    const outputs = results.map(
      (r) => `### ${r.providerId} (${r.assignmentId})\n${r.output}`,
    );
    const concatenated = outputs.join("\n\n---\n\n");

    switch (config.mergeStrategy) {
      case "summarize":
        if (config.validator) {
          try {
            const response = await config.validator.chat({
              prompt: `Please synthesize and summarize the following results into a unified summary:\n\n${concatenated}`,
            });
            return response.text;
          } catch {
            return concatenated;
          }
        }
        return concatenated;

      case "debate":
        if (config.validator) {
          try {
            const response = await config.validator.chat({
              prompt: `Compare the following approaches and determine the best one, explaining your reasoning:\n\n${concatenated}`,
            });
            return response.text;
          } catch {
            return concatenated;
          }
        }
        return concatenated;

      case "concatenate":
      default:
        return concatenated;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
