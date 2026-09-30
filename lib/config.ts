/**
 * opencode-hermes — configuration.
 *
 * Precedence (highest first): environment variables > config file > defaults.
 * Config file: ~/.config/opencode/opencode-hermes.json (JSON or JSONC),
 * override path with HERMES_OPENCODE_CONFIG.
 *
 * Memory-limit defaults match Hermes' built-in memory (tools/memory_tool.py):
 *   memory_char_limit = 2200, user_char_limit = 1375.
 * `provider` selects the optional external long-term-memory backend
 * ("none" | "sqlite"); Hermes ships built-in-only by default.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type HermesConfig = {
  memoryCharLimit: number;
  userCharLimit: number;
  nudgeInterval: number;
  provider: string;
  providerPath?: string;
  /** Provider-specific options passed through to the provider's initialize(). */
  providerOptions: Record<string, unknown>;
  prefetchLimit: number;
  /** Run the provider's idle reconciliation ("dream") when supported. */
  dream: boolean;
  /** Let the dream consult the model for ambiguous near-duplicate notes. */
  dreamJudge: boolean;
};

export const HERMES_DEFAULTS: HermesConfig = {
  memoryCharLimit: 2200,
  userCharLimit: 1375,
  nudgeInterval: 10,
  provider: "none",
  providerOptions: {},
  prefetchLimit: 5,
  dream: true,
  dreamJudge: false,
};

export function configFile(): string {
  return process.env.HERMES_OPENCODE_CONFIG ?? path.join(os.homedir(), ".config", "opencode", "opencode-hermes.json");
}

/**
 * Strip JSONC comments and trailing commas, character-by-character rather than
 * with regexes, so string contents are never touched: `//`/`/*` inside a value
 * (a `file://` URL, a glob like `src/**\/*.ts`, prose) survive, and JSONC's
 * optional trailing commas (which `JSON.parse` rejects) are removed. The old
 * regex approach truncated such values and could not handle trailing commas.
 */
function stripJsonc(text: string): string {
  return stripTrailingCommas(stripComments(text));
}

function stripComments(text: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < text.length) {
        out += text[i + 1];
        i++;
      } else if (c === quote) {
        inString = false;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      out += c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i++;
      i--; // let the loop append the newline
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 1;
      out += " "; // keep the two sides from merging into one token
      continue;
    }
    out += c;
  }
  return out;
}

function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < text.length) {
        out += text[i + 1];
        i++;
      } else if (c === quote) {
        inString = false;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      out += c;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") continue; // drop trailing comma
    }
    out += c;
  }
  return out;
}

function readFileConfig(): Partial<HermesConfig> {
  try {
    const parsed = JSON.parse(stripJsonc(fs.readFileSync(configFile(), "utf-8")));
    return parsed && typeof parsed === "object" ? (parsed as Partial<HermesConfig>) : {};
  } catch {
    return {};
  }
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : undefined;
  return n !== undefined && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boolValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(s)) return true;
    if (["0", "false", "no", "off"].includes(s)) return false;
  }
  return undefined;
}

export function loadConfig(): HermesConfig {
  const file = readFileConfig();
  const env = process.env;
  return {
    memoryCharLimit:
      positiveInt(env.HERMES_OPENCODE_MEMORY_LIMIT) ?? positiveInt(file.memoryCharLimit) ?? HERMES_DEFAULTS.memoryCharLimit,
    userCharLimit:
      positiveInt(env.HERMES_OPENCODE_USER_LIMIT) ?? positiveInt(file.userCharLimit) ?? HERMES_DEFAULTS.userCharLimit,
    nudgeInterval:
      positiveInt(env.HERMES_NUDGE_INTERVAL) ?? positiveInt(file.nudgeInterval) ?? HERMES_DEFAULTS.nudgeInterval,
    provider: stringValue(env.HERMES_OPENCODE_PROVIDER) ?? stringValue(file.provider) ?? HERMES_DEFAULTS.provider,
    providerPath: stringValue(env.HERMES_OPENCODE_PROVIDER_PATH) ?? stringValue(file.providerPath),
    providerOptions:
      file.providerOptions && typeof file.providerOptions === "object"
        ? (file.providerOptions as Record<string, unknown>)
        : HERMES_DEFAULTS.providerOptions,
    prefetchLimit:
      positiveInt(env.HERMES_OPENCODE_PREFETCH_LIMIT) ?? positiveInt(file.prefetchLimit) ?? HERMES_DEFAULTS.prefetchLimit,
    dream: boolValue(env.HERMES_OPENCODE_DREAM) ?? boolValue(file.dream) ?? HERMES_DEFAULTS.dream,
    dreamJudge: boolValue(env.HERMES_OPENCODE_DREAM_JUDGE) ?? boolValue(file.dreamJudge) ?? HERMES_DEFAULTS.dreamJudge,
  };
}
