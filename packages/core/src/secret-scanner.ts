// ── Types ────────────────────────────────────────────────────

export interface SecretFinding {
  type: string;
  pattern: string;
  line: number;
  excerpt: string;
}

export interface SecretScanResult {
  clean: boolean;
  findings: SecretFinding[];
}

// ── Patterns ────────────────────────────────────────────────

interface SecretPattern {
  type: string;
  regex: RegExp;
  description: string;
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    type: "aws_access_key",
    regex: /AKIA[0-9A-Z]{16}/,
    description: "AWS Access Key ID",
  },
  {
    type: "private_key",
    regex: /-----BEGIN\s+(RSA|EC|DSA|OPENSSH)?\s*PRIVATE KEY-----/,
    description: "Private key header",
  },
  {
    type: "password_assignment",
    regex: /(?:password|passwd|pwd)\s*[:=]\s*["'][^"']{4,}["']/i,
    description: "Password assignment",
  },
  {
    type: "api_key_assignment",
    regex: /(?:api[_-]?key|apikey|secret[_-]?key)\s*[:=]\s*["'][^"']{8,}["']/i,
    description: "API key assignment",
  },
  {
    type: "bearer_token",
    regex: /Bearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/,
    description: "Bearer JWT token",
  },
  {
    type: "generic_secret",
    regex: /(?:token|secret|credential)\s*[:=]\s*["'][^"']{8,}["']/i,
    description: "Generic secret assignment",
  },
];

/**
 * Allowlist patterns — if a line matches ANY of these, secret findings on that line are suppressed.
 */
const ALLOWLIST_PATTERNS: RegExp[] = [
  /\$[A-Z_]+/,              // $ENV_VAR
  /\$\{[A-Z_]+\}/,          // ${ENV_VAR}
  /process\.env\.\w+/,      // process.env.KEY
  /<YOUR_[A-Z_]+>/,         // <YOUR_API_KEY>
];

// ── Scanner ────────────────────────────────────────────────

/**
 * Scan text for embedded secrets.
 * Accepts a single string or array of strings.
 * Returns { clean: true } if no secrets found.
 */
export function scanForSecrets(input: string | string[]): SecretScanResult {
  const lines = Array.isArray(input) ? input : input.split("\n");
  const findings: SecretFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const pattern of SECRET_PATTERNS) {
      const match = pattern.regex.exec(line);
      if (!match) continue;

      // Check if the line is covered by an allowlist pattern
      const isAllowed = ALLOWLIST_PATTERNS.some((allow) => allow.test(line));
      if (isAllowed) continue;

      findings.push({
        type: pattern.type,
        pattern: pattern.description,
        line: i + 1,
        excerpt: line.length > 80 ? line.slice(0, 80) + "..." : line,
      });
      break; // one finding per line is enough
    }
  }

  return {
    clean: findings.length === 0,
    findings,
  };
}
