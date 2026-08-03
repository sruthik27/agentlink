#!/usr/bin/env python3
"""Record a deterministic AgentLink demo as an asciinema v2 cast file."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import textwrap
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "dist" / "cli.js"
DEMO_ROOT = Path("/tmp/agentlink-demo")
CAST = ROOT / "demos" / "agentlink-demo.cast"

COMMANDS = [
    "rm -rf /tmp/agentlink-demo && mkdir -p /tmp/agentlink-demo/producer /tmp/agentlink-demo/consumer",
    "cd /tmp/agentlink-demo/producer && node {cli} init",
    "cd /tmp/agentlink-demo/producer && node {cli} start --topic 'Add account summary endpoint' --template api-change --max-rounds 4 --required-approvals 2",
    "cd /tmp/agentlink-demo/producer && node {cli} send --from api-agent --role assistant --body 'Producer will expose GET /accounts/:id/summary with id, balance, and status.'",
    "cd /tmp/agentlink-demo/producer && node {cli} contract --status Proposed --set-section 'API Surface' --content '- [x] Endpoint: GET /accounts/:id/summary\n- [x] Response fields: id, balance, status'",
    "cd /tmp/agentlink-demo/producer && node {cli} approve --from api-agent",
    "cd /tmp/agentlink-demo/producer && node {cli} approve --from web-agent",
    "cd /tmp/agentlink-demo/producer && node {cli} contract --status Accepted --sync-to ../consumer",
    "cd /tmp/agentlink-demo/producer && node {cli} status",
    "cd /tmp/agentlink-demo/consumer && python3 - <<'PY'\nfrom pathlib import Path\nprint(Path('.agentlink/CONTRACT.md').read_text().split('## Status')[0].strip())\nPY",
]

HEADER = {
    "version": 2,
    "width": 100,
    "height": 30,
    "timestamp": int(time.time()),
    "env": {"SHELL": "/bin/zsh", "TERM": "xterm-256color"},
    "title": "AgentLink two-repo contract negotiation demo",
}


def ansi_clean(text: str) -> str:
    return text.replace(str(ROOT), "/path/to/agentlink")


def main() -> None:
    subprocess.run(["npm", "run", "build", "--silent"], cwd=ROOT, check=True)
    shutil.rmtree(DEMO_ROOT, ignore_errors=True)
    CAST.parent.mkdir(parents=True, exist_ok=True)
    elapsed = 0.0
    lines: list[str] = [json.dumps(HEADER, separators=(",", ":"))]
    intro = textwrap.dedent(
        """\
        AgentLink demo: two local coding-agent workspaces negotiate and sync a durable contract.\r\n\r\n
        """
    )
    lines.append(json.dumps([elapsed, "o", intro], separators=(",", ":")))
    for command in COMMANDS:
        rendered = command.format(cli=str(CLI))
        display = ansi_clean(rendered)
        elapsed += 0.35
        lines.append(json.dumps([elapsed, "o", f"\u001b[1;36m$ {display}\u001b[0m\r\n"], separators=(",", ":")))
        proc = subprocess.run(rendered, cwd=ROOT, shell=True, text=True, capture_output=True)
        output = ansi_clean(proc.stdout + proc.stderr)
        if proc.returncode:
            output += f"\r\n(command exited {proc.returncode})\r\n"
        output = output.replace("\n", "\r\n")
        elapsed += max(0.2, min(1.4, len(output) / 2500))
        lines.append(json.dumps([elapsed, "o", output], separators=(",", ":")))
        if proc.returncode:
            raise SystemExit(proc.returncode)
    elapsed += 0.4
    lines.append(json.dumps([elapsed, "o", "\r\n\u001b[1;32mDone: producer and consumer now share the accepted CONTRACT.md.\u001b[0m\r\n"], separators=(",", ":")))
    CAST.write_text("\n".join(lines) + "\n")
    print(CAST)


if __name__ == "__main__":
    main()
