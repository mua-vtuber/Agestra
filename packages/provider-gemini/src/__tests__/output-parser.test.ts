import { describe, it, expect } from "vitest";
import { filterGeminiOutput, parseGeminiJsonOutput } from "../output-parser.js";

describe("Gemini output parser", () => {
  describe("filterGeminiOutput", () => {
    it("should extract text from mixed output", () => {
      const output = "Loaded cached credentials\nActual response here\n[debug] info";
      const result = filterGeminiOutput(output);
      expect(result).toBe("Actual response here");
    });

    it("should handle clean output without noise", () => {
      const output = "This is a clean response.";
      expect(filterGeminiOutput(output)).toBe("This is a clean response.");
    });

    it("should handle multiline responses", () => {
      const output = "Loaded cached credentials\nLine 1\nLine 2\n[debug] info";
      const result = filterGeminiOutput(output);
      expect(result).toContain("Line 1");
      expect(result).toContain("Line 2");
    });

    it("should filter Using and Model lines", () => {
      const output = "Using gemini-2.5-pro\nModel: gemini-2.5-pro\nActual answer";
      const result = filterGeminiOutput(output);
      expect(result).toBe("Actual answer");
    });

    it("should strip empty lines at start and end", () => {
      const output = "\n\n  \nHello\n  \n\n";
      const result = filterGeminiOutput(output);
      expect(result).toBe("Hello");
    });

    it("should filter [info] and [warn] lines", () => {
      const output = "[info] starting\n[warn] low memory\nResponse text";
      const result = filterGeminiOutput(output);
      expect(result).toBe("Response text");
    });

    it("should return empty string if all lines are noise", () => {
      const output = "Loaded cached credentials\n[debug] done\n[info] exit";
      const result = filterGeminiOutput(output);
      expect(result).toBe("");
    });
  });

  describe("parseGeminiJsonOutput", () => {
    it("should parse full -o json output with response and stats", () => {
      const output = JSON.stringify({
        session_id: "abc-123",
        response: "Hello.",
        stats: {
          models: {
            "gemini-3-flash-preview": {
              api: { totalRequests: 1 },
              roles: { main: { totalRequests: 1 } },
            },
          },
        },
      });
      expect(parseGeminiJsonOutput(output)).toBe("Hello.");
    });

    it("should parse simple JSON with response field", () => {
      const output = '{"response": "Hello world"}';
      expect(parseGeminiJsonOutput(output)).toBe("Hello world");
    });

    it("should find JSON among non-JSON lines (fallback)", () => {
      const output = 'Some noise\n{"response": "Found it"}\nMore noise';
      expect(parseGeminiJsonOutput(output)).toBe("Found it");
    });

    it("should return null when no JSON with response field", () => {
      const output = "Just plain text\nNo JSON here";
      expect(parseGeminiJsonOutput(output)).toBeNull();
    });

    it("should return null for JSON without response field", () => {
      const output = '{"status": "ok"}';
      expect(parseGeminiJsonOutput(output)).toBeNull();
    });
  });
});
