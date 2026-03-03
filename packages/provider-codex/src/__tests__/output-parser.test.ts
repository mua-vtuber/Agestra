import { describe, it, expect } from "vitest";
import { parseCodexOutput } from "../output-parser.js";

describe("Codex output parser", () => {
  it("should parse item.completed agent_message events", () => {
    const output = [
      '{"type":"thread.started","thread_id":"abc123"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"Thinking..."}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Hello world"}}',
      '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10}}',
    ].join("\n");
    const result = parseCodexOutput(output);
    expect(result).toBe("Hello world");
  });

  it("should combine multiple agent_message items", () => {
    const output = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"Part 1"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Part 2"}}',
    ].join("\n");
    const result = parseCodexOutput(output);
    expect(result).toContain("Part 1");
    expect(result).toContain("Part 2");
  });

  it("should handle plain text output (non-JSON fallback)", () => {
    const output = "Plain text response here";
    const result = parseCodexOutput(output);
    expect(result).toBe("Plain text response here");
  });

  it("should handle mixed JSON and plain text", () => {
    const output = [
      "Some preamble",
      '{"type":"item.completed","item":{"type":"agent_message","text":"Actual response"}}',
      "Done",
    ].join("\n");
    const result = parseCodexOutput(output);
    expect(result).toContain("Actual response");
  });

  it("should handle empty output by returning trimmed original", () => {
    const output = "   ";
    const result = parseCodexOutput(output);
    expect(result).toBe("");
  });

  it("should skip non-agent_message events", () => {
    const output = [
      '{"type":"thread.started","thread_id":"abc"}',
      '{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Result"}}',
      '{"type":"turn.completed"}',
    ].join("\n");
    const result = parseCodexOutput(output);
    expect(result).toBe("Result");
  });

  it("should handle item.completed without text field", () => {
    const output = '{"type":"item.completed","item":{"type":"agent_message"}}';
    const result = parseCodexOutput(output);
    // No text field in agent_message, falls back to raw line
    expect(result).toBeTruthy();
  });
});
