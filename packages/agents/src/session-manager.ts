import { mkdirSync, readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { atomicWriteJsonSync } from "@agestra/core";

export type SessionType = "debate" | "review" | "task";
export type SessionStatus = "pending" | "in_progress" | "completed" | "failed";

export interface Session {
  id: string;
  type: SessionType;
  status: SessionStatus;
  config: Record<string, unknown>;
  result?: string;
  createdAt: string;
  updatedAt: string;
}

export class SessionManager {
  private sessionDir: string;
  private sessions: Map<string, Session>;

  constructor(baseDir: string) {
    this.sessionDir = join(baseDir, "sessions");
    mkdirSync(this.sessionDir, { recursive: true });
    this.sessions = new Map();
    this.loadSessions();
  }

  createSession(type: SessionType, config: Record<string, unknown>): Session {
    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      type,
      status: "pending",
      config,
      createdAt: now,
      updatedAt: now,
    };

    this.sessions.set(session.id, session);
    this.persist(session);
    return session;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  listSessions(): Session[] {
    return [...this.sessions.values()];
  }

  updateSessionStatus(id: string, status: SessionStatus): void {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);

    session.status = status;
    session.updatedAt = new Date().toISOString();
    this.persist(session);
  }

  completeSession(id: string, result: string): void {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);

    session.status = "completed";
    session.result = result;
    session.updatedAt = new Date().toISOString();
    this.persist(session);
  }

  private persist(session: Session): void {
    const path = join(this.sessionDir, `${session.id}.json`);
    atomicWriteJsonSync(path, session);
  }

  private loadSessions(): void {
    if (!existsSync(this.sessionDir)) return;
    const files = readdirSync(this.sessionDir).filter((f) =>
      f.endsWith(".json"),
    );
    for (const file of files) {
      const content = readFileSync(join(this.sessionDir, file), "utf-8");
      const session = JSON.parse(content) as Session;
      this.sessions.set(session.id, session);
    }
  }
}
