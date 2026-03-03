import { readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { durableAppendSync } from "@agestra/core";

export interface Message {
  from: string;
  content: string;
  timestamp?: string;
  [key: string]: unknown;
}

export interface MessageQueue {
  send(sessionId: string, msg: Message): void;
  receive(sessionId: string): Message[];
  recover(sessionId: string): Message[];
}

export class DurableMessageQueue implements MessageQueue {
  private cache = new Map<string, Message[]>();
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  send(sessionId: string, msg: Message): void {
    // Add timestamp
    const enriched = { ...msg, timestamp: msg.timestamp || new Date().toISOString() };

    // In-memory
    if (!this.cache.has(sessionId)) {
      this.cache.set(sessionId, []);
    }
    this.cache.get(sessionId)!.push(enriched);

    // Persist — append-only JSONL
    const logPath = join(this.dir, `${sessionId}.jsonl`);
    durableAppendSync(logPath, JSON.stringify(enriched) + "\n");
  }

  receive(sessionId: string): Message[] {
    if (this.cache.has(sessionId)) {
      return [...this.cache.get(sessionId)!];
    }
    // Try loading from file
    return this.recover(sessionId);
  }

  recover(sessionId: string): Message[] {
    const logPath = join(this.dir, `${sessionId}.jsonl`);
    if (!existsSync(logPath)) return [];

    const content = readFileSync(logPath, "utf-8");
    const lines = content.split("\n").filter(line => line.trim());
    const messages: Message[] = [];
    let skipped = 0;
    for (const line of lines) {
      try {
        messages.push(JSON.parse(line) as Message);
      } catch {
        skipped++;
      }
    }
    if (skipped > 0) {
      console.warn(`[message-queue] Skipped ${skipped} corrupted line(s) in session ${sessionId}`);
    }

    // Populate cache
    this.cache.set(sessionId, messages);
    return [...messages];
  }
}
