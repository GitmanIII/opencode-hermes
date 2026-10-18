/**
 * opencode-hermes — append-only plugin log with size-based rotation.
 *
 * Shared by both entrypoints so V1 and V2 write to the same file. Logging must
 * never throw: a broken log must not break a turn.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const LOG_FILE =
  process.env.HERMES_OPENCODE_LOG ?? path.join(process.env.HOME ?? ".", ".local", "share", "opencode", "log", "opencode-hermes.log");
const LOG_MAX_BYTES = 1 * 1024 * 1024;
const LOG_ROTATE_CHECK_INTERVAL_MS = 30_000;

let lastRotateCheckAt = 0;

function rotateLog(): void {
  const now = Date.now();
  if (now - lastRotateCheckAt < LOG_ROTATE_CHECK_INTERVAL_MS) return;
  lastRotateCheckAt = now;
  try {
    let stat: ReturnType<typeof fs.statSync> | undefined;
    try {
      stat = fs.statSync(LOG_FILE);
    } catch {
      return;
    }
    if (!stat.isFile() || stat.size < LOG_MAX_BYTES) return;
    fs.rmSync(`${LOG_FILE}.2`, { force: true });
    if (fs.existsSync(`${LOG_FILE}.1`)) fs.renameSync(`${LOG_FILE}.1`, `${LOG_FILE}.2`);
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    /* ignore */
  }
}

export function createFileLogger(): (msg: string) => void {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  } catch {
    /* ignore */
  }
  return (msg: string) => {
    try {
      rotateLog();
      fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
    } catch {
      /* ignore */
    }
  };
}
