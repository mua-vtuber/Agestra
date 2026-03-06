// ── Types ────────────────────────────────────────────────────

export interface TaskManifest {
  task: string;
  files: {
    readonly: string[];
    readwrite: string[];
  };
  constraints?: string;
  success_criteria: string[];
  permissions: {
    sandbox_root: string;
    allowed_commands: string[];
  };
  timeout_minutes: number;
}

export interface GenerateManifestArgs {
  taskDescription: string;
  workingDir: string;
  filesToRead?: string[];
  filesToModify?: string[];
  constraints?: string;
  successCriteria?: string[];
  timeoutMinutes?: number;
}

export interface ManifestValidation {
  valid: boolean;
  errors: string[];
}

// ── Constants ───────────────────────────────────────────────

const DEFAULT_ALLOWED_COMMANDS = ["npm", "node", "git", "tsc"];
const DEFAULT_TIMEOUT_MINUTES = 10;

// ── Functions ───────────────────────────────────────────────

export function generateManifest(args: GenerateManifestArgs): TaskManifest {
  return {
    task: args.taskDescription,
    files: {
      readonly: args.filesToRead ?? [],
      readwrite: args.filesToModify ?? [],
    },
    constraints: args.constraints,
    success_criteria: args.successCriteria ?? [],
    permissions: {
      sandbox_root: args.workingDir,
      allowed_commands: [...DEFAULT_ALLOWED_COMMANDS],
    },
    timeout_minutes: args.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES,
  };
}

export function validateManifest(manifest: TaskManifest): ManifestValidation {
  const errors: string[] = [];

  if (!manifest.task || manifest.task.trim().length === 0) {
    errors.push("task must not be empty");
  }

  if (!manifest.permissions.sandbox_root || manifest.permissions.sandbox_root.trim().length === 0) {
    errors.push("permissions.sandbox_root must not be empty");
  }

  if (manifest.timeout_minutes <= 0) {
    errors.push("timeout_minutes must be positive");
  }

  return { valid: errors.length === 0, errors };
}
