import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { DocumentManager } from "../documents.js";

describe("DocumentManager", () => {
  let dir: string;
  let dm: DocumentManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ws-test-"));
    dm = new DocumentManager(dir);
  });

  afterEach(() => { rmSync(dir, { recursive: true }); });

  it("should create a review document", async () => {
    const doc = await dm.createReview({
      files: ["src/auth.ts"],
      rules: ["No hardcoding", "Error handling required"],
    });
    expect(doc.id).toBeTruthy();
    expect(doc.content).toContain("src/auth.ts");
  });

  it("should generate full UUID document IDs", async () => {
    const doc = await dm.createReview({ files: ["a.ts"], rules: [] });
    expect(doc.id).toHaveLength(36);
    expect(doc.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("should add a comment to a document", async () => {
    const doc = await dm.createReview({ files: ["a.ts"], rules: [] });
    await dm.addComment(doc.id, {
      author: "gemini",
      content: "Found issue on line 42",
    });
    const updated = await dm.read(doc.id);
    expect(updated.content).toContain("gemini");
    expect(updated.content).toContain("line 42");
  });

  it("should list all documents", async () => {
    await dm.createReview({ files: ["a.ts"], rules: [] });
    await dm.createReview({ files: ["b.ts"], rules: [] });
    const docs = await dm.list();
    expect(docs).toHaveLength(2);
  });
});
