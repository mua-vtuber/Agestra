import { describe, it, expect } from "vitest";
import { extractJsonFromText, extractJSON } from "../json-parser.js";

describe("extractJsonFromText", () => {
  it("parses pure JSON text", () => {
    const result = extractJsonFromText('{"passed": true, "feedback": "looks good"}');
    expect(result).toEqual({ passed: true, feedback: "looks good" });
  });

  it("extracts JSON surrounded by text", () => {
    const text = `Here is my review:
{"passed": false, "feedback": "missing error handling"}
That's my assessment.`;
    const result = extractJsonFromText(text);
    expect(result).toEqual({ passed: false, feedback: "missing error handling" });
  });

  it("handles nested JSON objects", () => {
    const text = `Result: {"outer": {"inner": "value"}, "count": 3}`;
    const result = extractJsonFromText(text) as any;
    expect(result.outer).toEqual({ inner: "value" });
    expect(result.count).toBe(3);
  });

  it("returns last valid JSON when multiple are present", () => {
    const text = `First: {"id": 1}
Some text
Second: {"id": 2, "final": true}`;
    const result = extractJsonFromText(text) as any;
    expect(result.id).toBe(2);
    expect(result.final).toBe(true);
  });

  it("returns null when no JSON is found", () => {
    expect(extractJsonFromText("no json here")).toBeNull();
    expect(extractJsonFromText("")).toBeNull();
    expect(extractJsonFromText("just { some broken")).toBeNull();
  });

  it("handles JSON in markdown code fences", () => {
    const text = "```json\n{\"key\": \"value\"}\n```";
    const result = extractJsonFromText(text) as any;
    expect(result.key).toBe("value");
  });

  it("returns null for null/undefined input", () => {
    expect(extractJsonFromText(null as any)).toBeNull();
    expect(extractJsonFromText(undefined as any)).toBeNull();
  });

  it("skips invalid JSON candidates and finds valid one", () => {
    // First candidate has invalid JSON content, second is valid
    const text = `{invalid json here} then {"valid": true}`;
    const result = extractJsonFromText(text) as any;
    expect(result.valid).toBe(true);
  });
});

describe("extractJSON (alias)", () => {
  it("is an alias for extractJsonFromText", () => {
    const input = '{"key": "value"}';
    expect(extractJSON(input)).toEqual(extractJsonFromText(input));
  });

  it("works with mixed text input", () => {
    const text = 'Here is JSON: {"passed": true}';
    const result = extractJSON(text) as any;
    expect(result.passed).toBe(true);
  });
});
