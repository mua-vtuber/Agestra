export interface DetectedModel {
  name: string;
  size: number;
  strengths: string[];
}

export async function detectModels(host: string): Promise<DetectedModel[]> {
  const res = await fetch(`${host}/api/tags`);
  if (!res.ok) throw new Error(`Ollama API error: ${res.status}`);
  const data = (await res.json()) as any;
  return (data.models || []).map((m: any) => ({
    name: m.name,
    size: m.size || 0,
    strengths: inferStrengths(m.name),
  }));
}

function inferStrengths(modelName: string): string[] {
  const strengths: string[] = ["chat"];
  const lower = modelName.toLowerCase();
  if (lower.includes("coder") || lower.includes("code")) {
    strengths.push("code_review", "code_generation");
  }
  if (lower.includes("instruct")) {
    strengths.push("instruction_following");
  }
  if (lower.includes("embed")) {
    strengths.push("embedding");
  }
  return strengths;
}
