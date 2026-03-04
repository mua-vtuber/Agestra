import { describe, it, expect } from "vitest";
import { SessionCache } from "../session-cache.js";

describe("SessionCache (L1 memory tier)", () => {
  it("stores and retrieves by keyword match", () => {
    const cache = new SessionCache();
    cache.add("session1", "Gemini is good at code review");
    cache.add("session1", "Use Codex for architecture tasks");

    const results = cache.search("code review");
    expect(results.length).toBe(1);
    expect(results[0].content).toContain("code review");
  });

  it("returns empty for no match", () => {
    const cache = new SessionCache();
    cache.add("s1", "hello world");
    expect(cache.search("database")).toHaveLength(0);
  });

  it("clears a session", () => {
    const cache = new SessionCache();
    cache.add("s1", "TypeScript frontend framework");
    cache.add("s2", "Python backend server");

    cache.clearSession("s1");
    expect(cache.search("TypeScript frontend")).toHaveLength(0);
    expect(cache.search("Python backend")).toHaveLength(1);
  });

  it("relevance threshold filters weak matches", () => {
    const cache = new SessionCache();
    cache.add("s1", "TypeScript React Next.js frontend development");
    cache.add("s1", "Python Django backend development");

    const results = cache.search("TypeScript React");
    expect(results.length).toBe(1);
    expect(results[0].content).toContain("TypeScript");
  });

  it("size property reflects entries", () => {
    const cache = new SessionCache();
    expect(cache.size).toBe(0);
    cache.add("s1", "entry one");
    expect(cache.size).toBe(1);
    cache.add("s1", "entry two");
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
