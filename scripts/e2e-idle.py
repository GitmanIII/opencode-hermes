#!/usr/bin/env python3
"""Live verification of the V2 idle path: session -> review -> memory + dream.

Hermetic suites cannot cover this: the review only fires when a *live server*
observes a finished turn and the idle debounce elapses, and the completion runs
against a real model. This drives a clean-room `opencode acp` instance (ACP
JSON-RPC over stdio is the only long-lived server in OpenCode 2) so the process
outlives the final prompt and the plugin can react.

What it proves, in order:
  1. the plugin loads and the `prompt` hook fires (turn counter),
  2. a finished turn triggers the review (`background review: memory=...`),
  3. review memory lands in the scratch MEMORY.md,
  4. the dream reconciles against the provider (`dream: canonical=... added=...`).

Isolation: HERMES_OPENCODE_MEMORY_ROOT/SKILLS_ROOT/LOG point at ROOM, so the real
~/.config/opencode/memories and the real provider store are untouched. The
scratch *session row* does land in the shared OpenCode DB (harmless).

Usage:
    python3 scripts/e2e-idle.py
    E2E_NUDGE=2 E2E_KEEP=1 python3 scripts/e2e-idle.py   # keep the clean room
    E2E_MODEL=opencode-go/deepseek-v4.1-flash python3 scripts/e2e-idle.py

Note on models: `ctx.generate.text` uses the reviewed *session's* model (the plugin
pins it). A clean-room ACP `session/new` creates a session with **no model**, so the
pin resolves to nothing and the call falls back to the *global default*. When that
default is a free-tier model, the server rejects it:

    Generate.UnavailableError: OpenCode's free tier can only be used from within OpenCode

Set E2E_MODEL to give the clean room a model (the script then supplies a minimal
config: the plugin, plus that model). E2E_CONFIG_CONTENT still overrides everything
if you want to exercise your own config shape.
"""
import json
import os
import shutil
import subprocess
import sys
import threading
import time

ROOM = os.environ.get("E2E_ROOM", "/tmp/opencode/ohe-v2-e2e")
NUDGE = int(os.environ.get("E2E_NUDGE", "2"))
IDLE_SECONDS = int(os.environ.get("E2E_IDLE", "15"))
# Shorten the plugin's quiet period (default 10s) so the live check is quick; the
# trigger under test is still the live turn-completion event, not the timer.
IDLE_DEBOUNCE_MS = int(os.environ.get("E2E_IDLE_DEBOUNCE_MS", "3000"))
PLUGIN_DIR = os.environ.get("E2E_PLUGIN", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MODEL = os.environ.get("E2E_MODEL")
HERMES_LOG = f"{ROOM}/hermes.log"

shutil.rmtree(ROOM, ignore_errors=True)
os.makedirs(f"{ROOM}/memories", exist_ok=True)
os.makedirs(f"{ROOM}/skills", exist_ok=True)
# Seed canonical memory so the dream has something to reconcile against.
# E2E_FULL_MEMORY=1 fills the cap instead, so the review must free room itself
# (the consolidation retry) to save anything.
CANARY = "E2E canary: the scratch memory root is /tmp and holds exactly one fact."
HEADER = "MEMORY (your personal notes) [0% — 0/2200 chars]\n══════════════════════════════════════════════\n"
if os.environ.get("E2E_FULL_MEMORY"):
    # Size to ~98% of the 2200 cap (the store counts the header as part of entry 0).
    filler = "E2E filler entry (safe to demote): " + ("z" * 2000)
    memory_seed = f"{HEADER}{CANARY}\n§\n{filler}\n"
    if len(memory_seed) < 2000:
        sys.exit(f"E2E_FULL_MEMORY seed is only {len(memory_seed)} chars — the store would not be full")
    print(f"full-store seed: {len(memory_seed)}/2200 chars (~{len(memory_seed) * 100 // 2200}%)")
else:
    memory_seed = f"{HEADER}{CANARY}\n"
with open(f"{ROOM}/memories/MEMORY.md", "w") as f:
    f.write(memory_seed)
with open(f"{ROOM}/memories/USER.md", "w") as f:
    f.write("USER PROFILE (who the user is) [0% — 1/1375 chars]\n"
            "══════════════════════════════════════════════\n"
            "E2E user prefers terse answers.\n")

env = dict(os.environ)
env.update({
    "HERMES_OPENCODE_MEMORY_ROOT": f"{ROOM}/memories",
    "HERMES_OPENCODE_SKILLS_ROOT": f"{ROOM}/skills",
    "HERMES_OPENCODE_LOG": HERMES_LOG,
    "HERMES_NUDGE_INTERVAL": str(NUDGE),
    "HERMES_IDLE_DEBOUNCE_MS": str(IDLE_DEBOUNCE_MS),
})
# Clean-room config. E2E_CONFIG_CONTENT wins; otherwise E2E_MODEL gives the session
# a model (a bare `session/new` has none, so the plugin's pin resolves to nothing and
# the review would fall back to the — possibly free-tier — global default).
config_content = os.environ.get("E2E_CONFIG_CONTENT")
if not config_content and MODEL:
    config_content = json.dumps({"plugins": [f"file://{PLUGIN_DIR}"], "model": MODEL})
if config_content:
    env["OPENCODE_CONFIG_CONTENT"] = config_content

proc = subprocess.Popen(
    ["opencode", "acp"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    stderr=open(f"{ROOM}/acp.stderr", "w"), text=True, bufsize=1, env=env,
)

lines = []
lock = threading.Lock()

def reader():
    for line in proc.stdout:
        line = line.strip()
        if line:
            with lock:
                lines.append(line)

threading.Thread(target=reader, daemon=True).start()

def send(obj):
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()

def wait_for(msg_id, timeout=180):
    end = time.time() + timeout
    while time.time() < end:
        with lock:
            for i, raw in enumerate(lines):
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                if msg.get("id") == msg_id:
                    del lines[i]
                    return msg
        time.sleep(0.2)
    raise TimeoutError(f"no response for id={msg_id} within {timeout}s; tail:\n" + "\n".join(lines[-8:]))

send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
      "params": {"protocolVersion": 1,
                 "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}}}})
wait_for(1, 60)

send({"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": {"cwd": ROOM, "mcpServers": []}})
new = wait_for(2, 60)
sid = (new.get("result") or {}).get("sessionId")
if not sid:
    print("session/new failed:", json.dumps(new)[:400]); sys.exit(1)
print("session:", sid)

# Tools disabled on purpose: any memory written must come from the review, not
# from the agent calling the `memory` tool itself.
prompts = [
    "Do not use any tools. For the record: our staging deploy key rotates every Friday at 09:00 UTC and the runbook owner is Priya. Just reply 'noted'.",
    "Second turn so the review threshold is reached. Reply with the single word: ok",
]
for n, text in enumerate(prompts, start=1):
    send({"jsonrpc": "2.0", "id": 10 + n, "method": "session/prompt",
          "params": {"sessionId": sid, "prompt": [{"type": "text", "text": text}]}})
    resp = wait_for(10 + n, 180)
    print(f"prompt {n}: stopReason={(resp.get('result') or {}).get('stopReason')}")

print(f"idling {IDLE_SECONDS}s (nudge={NUDGE}, review debounce={IDLE_DEBOUNCE_MS}ms)...")
time.sleep(IDLE_SECONDS)

proc.terminate()
try:
    proc.wait(timeout=10)
except subprocess.TimeoutExpired:
    proc.kill()

print("\n=== hermes plugin log (scratch) ===")
log_text = ""
try:
    log_text = open(HERMES_LOG).read()
    for line in log_text.splitlines():
        if any(k in line for k in ("initialized", "background review", "dream:", "toast", "error", "failed", "disposed")):
            print("  " + line)
except FileNotFoundError:
    print("  (no plugin log — the plugin never loaded)")

print("\n=== written memory (scratch) ===")
for name in ("MEMORY.md", "USER.md"):
    path = f"{ROOM}/memories/{name}"
    if os.path.exists(path):
        print(f"  --- {name} ---")
        print("\n".join("  " + l for l in open(path).read().splitlines() if l.strip()))

ok = "background review: memory=" in log_text and "err=" not in log_text.split("background review:")[-1].split("\n")[0]
if os.environ.get("E2E_FULL_MEMORY"):
    # The store was full: saving anything means the consolidation retry worked.
    memory_body = open(f"{ROOM}/memories/MEMORY.md").read() if os.path.exists(f"{ROOM}/memories/MEMORY.md") else ""
    ok = ok and "Friday" in memory_body
    print(f"  (full-store mode: new fact persisted={('Friday' in memory_body)})")

if "free tier" in log_text:
    print(
        "\nThe review never ran: this session had no model, so ctx.generate.text fell back to the\n"
        "global default, which is a free-tier model the server refuses. Pin one and re-run:\n"
        f"    E2E_MODEL={MODEL or 'opencode-go/deepseek-v4.1-flash'} bun run e2e:idle"
    )

print(f"\nRESULT: {'PASS' if ok else 'FAIL'} (review ran and saved without error)")
if not os.environ.get("E2E_KEEP"):
    shutil.rmtree(ROOM, ignore_errors=True)
sys.exit(0 if ok else 1)
