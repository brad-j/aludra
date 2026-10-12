// A copy of ~/.pi/agent/lib/protected-paths.ts, the rules of terminal pi's protected-path gate, for the same gate in
// Pi Durable (permissions.ts). Keep the two in step.

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type ProtectedPathKind =
  | "agent authentication"
  | "Cloak configuration"
  | "environment or credential file"
  | "private key material";

export type ProtectedCommandMatch = {
  kind: ProtectedPathKind;
  target: string;
};

const CREDENTIAL_FILES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  "application_default_credentials.json",
  "credentials",
  "credentials.json",
  "credentials.toml",
  "credentials.yaml",
  "credentials.yml",
  "kubeconfig",
  "secrets.json",
  "secrets.toml",
  "secrets.yaml",
  "secrets.yml",
]);

const PRIVATE_KEY_DIRECTORIES = new Set([
  ".gnupg",
  ".ssh",
  "private-keys",
  "private_keys",
]);

const PRIVATE_KEY_FILES = /^(?:id_(?:dsa|ecdsa|ed25519|rsa)|.+\.(?:key|p12|pfx|pem))$/i;

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith(`~${sep}`)) return resolve(homedir(), path.slice(2));
  return path;
}

function canonicalizeExistingParent(path: string): string | undefined {
  const missingParts: string[] = [];
  let candidate = path;

  while (true) {
    try {
      return resolve(realpathSync.native(candidate), ...missingParts.reverse());
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return undefined;
      missingParts.push(basename(candidate));
      candidate = parent;
    }
  }
}

/** Match Pi's built-in path spelling rules before checking aliases. */
export function resolveProtectedToolPath(path: string, cwd: string): string {
  const normalized = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
  const expanded = normalized.startsWith("file://") ? fileURLToPath(normalized) : expandHome(normalized);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function pathCandidates(path: string, cwd: string): string[] {
  // The local see tool only strips @; check that literal path as well as Pi's
  // normalized spelling so normalization cannot hide a symlink's destination.
  const literal = resolve(cwd, path.replace(/^@/, ""));
  const normalized = resolveProtectedToolPath(path, cwd);
  return [...new Set([literal, normalized].flatMap((candidate) => {
    const canonical = canonicalizeExistingParent(candidate);
    return canonical ? [candidate, canonical] : [candidate];
  }))];
}

function classifyAbsolutePath(path: string): ProtectedPathKind | undefined {
  const parts = path.split(sep).filter(Boolean);
  const basename = parts.at(-1)?.toLowerCase() ?? "";

  if (basename === "auth.json") return "agent authentication";
  if (basename === "cloak.json") return "Cloak configuration";
  if (basename === ".env" || basename === ".envrc" || basename.startsWith(".env.")) {
    return "environment or credential file";
  }
  if (CREDENTIAL_FILES.has(basename) || basename.startsWith(".credentials.")) {
    return "environment or credential file";
  }
  if (
    parts.some((part) => PRIVATE_KEY_DIRECTORIES.has(part.toLowerCase())) ||
    parts.some((part, index) => part.toLowerCase() === ".pki" && parts[index + 1]?.toLowerCase() === "private") ||
    PRIVATE_KEY_FILES.test(basename)
  ) {
    return "private key material";
  }

  return undefined;
}

export function classifyProtectedPath(path: string, cwd: string): ProtectedPathKind | undefined {
  if (!path.trim()) return undefined;

  for (const candidate of pathCandidates(path, cwd)) {
    const kind = classifyAbsolutePath(candidate);
    if (kind) return kind;
  }

  return undefined;
}

const PROTECTED_COMMAND_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  kind: ProtectedPathKind;
}> = [
  {
    pattern: /(?:^|[\s'"=/:])(?<target>auth\.json)(?=$|[\s'";&|/])/i,
    kind: "agent authentication",
  },
  {
    pattern: /(?:^|[\s'"=/:])(?<target>cloak\.json)(?=$|[\s'";&|/])/i,
    kind: "Cloak configuration",
  },
  {
    pattern: /(?:^|[\s'"=/:])(?<target>\.env(?:rc|\.[a-z0-9_.-]+)?)(?=$|[\s'";&|/])/i,
    kind: "environment or credential file",
  },
  {
    pattern: /(?:^|[\s'"=/:])(?<target>\.?(?:credentials)(?:\.(?:json|toml|ya?ml))?|application_default_credentials\.json|\.netrc|\.npmrc|\.pypirc|kubeconfig|secrets\.(?:json|toml|ya?ml))(?=$|[\s'";&|/])/i,
    kind: "environment or credential file",
  },
  {
    pattern: /(?:^|[\s'"=/:])(?<target>\.pki\/private)(?=$|[\s'";&|/])/i,
    kind: "private key material",
  },
  {
    pattern: /(?:^|[\s'"=/:])(?<target>id_(?:dsa|ecdsa|ed25519|rsa)|[^\s'";&|/]+\.(?:key|p12|pfx|pem))(?=$|[\s'";&|/])/i,
    kind: "private key material",
  },
  {
    pattern: /(?:^|[\s'"=/:])(?<target>\.ssh|\.gnupg|private[-_]keys)(?=$|[\s'";&|/])/i,
    kind: "private key material",
  },
];

// Remote web URLs name no local file, e.g. a public apt signing key ending in .key.
const WEB_URL = /\b(?:https?|ftp):\/\/[^\s'"]*/gi;

export function matchProtectedCommand(
  command: string,
  cwd: string,
): ProtectedCommandMatch | undefined {
  const cwdKind = classifyProtectedPath(cwd, cwd);
  if (cwdKind) return { kind: cwdKind, target: cwd };

  const localText = command.replace(WEB_URL, " ");
  for (const { pattern, kind } of PROTECTED_COMMAND_PATTERNS) {
    const target = pattern.exec(localText)?.groups?.target;
    if (target) return { kind, target };
  }

  return undefined;
}

export function classifyProtectedCommand(command: string, cwd: string): ProtectedPathKind | undefined {
  return matchProtectedCommand(command, cwd)?.kind;
}
