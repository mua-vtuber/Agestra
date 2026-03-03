import { mkdirSync, readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { atomicWriteJsonSync } from "@agestra/core";

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed";

export interface TaskCreateOptions {
  description: string;
  provider: string;
  files?: string[];
}

export interface TaskInfo {
  id: string;
  description: string;
  provider: string;
  files: string[];
  status: TaskStatus;
  result?: string;
  createdAt: string;
  updatedAt: string;
}

export class TaskManager {
  private taskDir: string;

  constructor(baseDir: string) {
    this.taskDir = join(baseDir, "tasks");
    mkdirSync(this.taskDir, { recursive: true });
  }

  async create(options: TaskCreateOptions): Promise<TaskInfo> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const task: TaskInfo = {
      id,
      description: options.description,
      provider: options.provider,
      files: options.files || [],
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };

    this.save(task);
    return task;
  }

  async get(taskId: string): Promise<TaskInfo> {
    const path = join(this.taskDir, `${taskId}.json`);
    if (!existsSync(path)) throw new Error(`Task not found: ${taskId}`);
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content) as TaskInfo;
  }

  async updateStatus(taskId: string, status: TaskStatus): Promise<TaskInfo> {
    const task = await this.get(taskId);
    task.status = status;
    task.updatedAt = new Date().toISOString();
    this.save(task);
    return task;
  }

  async complete(taskId: string, result: string): Promise<TaskInfo> {
    const task = await this.get(taskId);
    task.status = "completed";
    task.result = result;
    task.updatedAt = new Date().toISOString();
    this.save(task);
    return task;
  }

  async list(): Promise<TaskInfo[]> {
    if (!existsSync(this.taskDir)) return [];
    const files = readdirSync(this.taskDir).filter(f => f.endsWith(".json"));
    return files.map(f => {
      const content = readFileSync(join(this.taskDir, f), "utf-8");
      return JSON.parse(content) as TaskInfo;
    });
  }

  private save(task: TaskInfo): void {
    const path = join(this.taskDir, `${task.id}.json`);
    atomicWriteJsonSync(path, task);
  }
}
