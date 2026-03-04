export interface SessionCacheEntry {
  sessionId: string;
  content: string;
  keywords: Set<string>;
  addedAt: number;
}

export interface SessionCacheResult {
  content: string;
  score: number;
  sessionId: string;
}

export class SessionCache {
  private entries: SessionCacheEntry[] = [];

  add(sessionId: string, content: string): void {
    const keywords = this.extractKeywords(content);
    this.entries.push({ sessionId, content, keywords, addedAt: Date.now() });
  }

  search(query: string, minScore = 0.3): SessionCacheResult[] {
    const queryKeywords = this.extractKeywords(query);
    if (queryKeywords.size === 0) return [];

    const results: SessionCacheResult[] = [];

    for (const entry of this.entries) {
      let matches = 0;
      for (const kw of queryKeywords) {
        if (entry.keywords.has(kw)) matches++;
      }
      const score = matches / queryKeywords.size;

      if (score >= minScore) {
        results.push({ content: entry.content, score, sessionId: entry.sessionId });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  clearSession(sessionId: string): void {
    this.entries = this.entries.filter((e) => e.sessionId !== sessionId);
  }

  clear(): void {
    this.entries = [];
  }

  get size(): number {
    return this.entries.length;
  }

  private extractKeywords(text: string): Set<string> {
    return new Set(
      text.toLowerCase()
        .replace(/[^\w\s가-힣]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 1),
    );
  }
}
