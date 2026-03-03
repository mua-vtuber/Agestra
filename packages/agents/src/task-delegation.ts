import type { AIProvider } from "@agestra/core";
import type { TaskManager, TaskStatus } from "@agestra/workspace";

export class TaskDelegation {
  private taskManager: TaskManager;

  constructor(taskManager: TaskManager) {
    this.taskManager = taskManager;
  }

  async assignTask(
    provider: AIProvider,
    description: string,
    files: string[],
  ): Promise<string> {
    const task = await this.taskManager.create({
      description,
      provider: provider.id,
      files,
    });
    return task.id;
  }

  async executeTask(taskId: string, provider: AIProvider): Promise<string> {
    const task = await this.taskManager.get(taskId);
    await this.taskManager.updateStatus(taskId, "in_progress");

    const filesContext =
      task.files.length > 0
        ? `\n\nFiles to consider:\n${task.files.map((f) => `- ${f}`).join("\n")}`
        : "";

    const prompt = `Task: ${task.description}${filesContext}\n\nPlease complete this task and provide your response.`;

    try {
      const response = await provider.chat({ prompt });
      await this.taskManager.complete(taskId, response.text);
      return response.text;
    } catch (error) {
      await this.taskManager.updateStatus(taskId, "failed");
      throw error;
    }
  }

  async getTaskStatus(taskId: string): Promise<TaskStatus> {
    const task = await this.taskManager.get(taskId);
    return task.status;
  }
}
