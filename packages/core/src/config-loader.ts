import { z } from "zod";

const ExecutionPolicy = z.enum(["read-only", "workspace-write", "full-auto"]).default("read-only");

const ProviderConfigSchema = z.object({
  id: z.string(),
  type: z.string(),
  enabled: z.boolean().default(true),
  executionPolicy: ExecutionPolicy,
  config: z.record(z.unknown()).default({}),
});

const SelectionPolicy = z.enum(["default-only", "auto"]).default("default-only");

const RootConfigSchema = z.object({
  defaultProvider: z.string().optional(),
  selectionPolicy: SelectionPolicy,
  providers: z.array(ProviderConfigSchema).min(1, "At least one provider required"),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export interface ParsedConfig {
  defaultProvider?: string;
  selectionPolicy: "default-only" | "auto";
  providers: ProviderConfig[];
  enabledProviders: ProviderConfig[];
}

export function parseProviderConfig(raw: unknown): ParsedConfig {
  const parsed = RootConfigSchema.parse(raw);
  return {
    defaultProvider: parsed.defaultProvider,
    selectionPolicy: parsed.selectionPolicy,
    providers: parsed.providers,
    enabledProviders: parsed.providers.filter(p => p.enabled),
  };
}
