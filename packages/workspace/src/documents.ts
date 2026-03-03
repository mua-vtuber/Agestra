import { mkdirSync, readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { atomicWriteSync, durableAppendSync } from "@agestra/core";

export interface ReviewOptions {
  files: string[];
  rules: string[];
}

export interface Comment {
  author: string;
  content: string;
}

export interface Document {
  id: string;
  content: string;
  path: string;
}

export class DocumentManager {
  private reviewDir: string;

  constructor(baseDir: string) {
    this.reviewDir = join(baseDir, "reviews");
    mkdirSync(this.reviewDir, { recursive: true });
  }

  async createReview(options: ReviewOptions): Promise<Document> {
    const id = randomUUID();
    const path = join(this.reviewDir, `${id}.md`);

    let content = `# Code Review: ${id}\n\n`;
    content += `## Files\n\n`;
    for (const f of options.files) {
      content += `- ${f}\n`;
    }
    if (options.rules.length > 0) {
      content += `\n## Rules\n\n`;
      for (const r of options.rules) {
        content += `- ${r}\n`;
      }
    }
    content += `\n---\n\n`;

    atomicWriteSync(path, content);
    return { id, content, path };
  }

  async addComment(docId: string, comment: Comment): Promise<void> {
    const path = join(this.reviewDir, `${docId}.md`);
    if (!existsSync(path)) throw new Error(`Document not found: ${docId}`);

    const section = `\n## Comment by ${comment.author}\n\n${comment.content}\n\n---\n`;
    durableAppendSync(path, section);
  }

  async read(docId: string): Promise<Document> {
    const path = join(this.reviewDir, `${docId}.md`);
    if (!existsSync(path)) throw new Error(`Document not found: ${docId}`);
    const content = readFileSync(path, "utf-8");
    return { id: docId, content, path };
  }

  async list(): Promise<Document[]> {
    if (!existsSync(this.reviewDir)) return [];
    const files = readdirSync(this.reviewDir).filter(f => f.endsWith(".md"));
    return files.map(f => {
      const id = f.replace(".md", "");
      const path = join(this.reviewDir, f);
      const content = readFileSync(path, "utf-8");
      return { id, content, path };
    });
  }
}
