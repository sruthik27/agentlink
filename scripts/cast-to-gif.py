#!/usr/bin/env python3
"""Convert the deterministic AgentLink asciinema cast into a README-friendly GIF.

GitHub does not render `.cast` files as an inline player inside README markdown, but
it does play GIFs. This script renders the checked-in cast to an animated GIF using
Pillow so the demo is visible directly on the repo front page.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
CAST = ROOT / "demos" / "agentlink-demo.cast"
GIF = ROOT / "demos" / "agentlink-demo.gif"
ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")

WIDTH = 1100
HEIGHT = 660
PADDING = 26
LINE_HEIGHT = 20
MAX_LINES = 28
BG = "#0d1117"
FG = "#c9d1d9"
PROMPT = "#58a6ff"
OK = "#3fb950"
MUTED = "#8b949e"


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in [
        "/System/Library/Fonts/Menlo.ttc",
        "/Library/Fonts/Menlo.ttc",
        "/System/Library/Fonts/Supplemental/Monaco.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ]:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def clean(text: str) -> str:
    text = ANSI_RE.sub("", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return text


def append_wrapped(buffer: list[str], text: str, width_chars: int = 104) -> None:
    for raw in clean(text).split("\n"):
        if raw == "":
            buffer.append("")
            continue
        while len(raw) > width_chars:
            buffer.append(raw[:width_chars])
            raw = raw[width_chars:]
        buffer.append(raw)
    del buffer[:-MAX_LINES]


def draw_frame(buffer: list[str], title: str) -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(image)
    title_font = font(18)
    body_font = font(15)
    draw.rounded_rectangle((12, 12, WIDTH - 12, HEIGHT - 12), radius=16, outline="#30363d", width=2)
    draw.text((PADDING, 22), title, font=title_font, fill=FG)
    draw.text((WIDTH - 190, 25), "AgentLink demo", font=font(13), fill=MUTED)
    y = 62
    for line in buffer[-MAX_LINES:]:
        fill = FG
        if line.startswith("$ "):
            fill = PROMPT
        elif line.startswith("Done") or "Accepted" in line or "Synced contract" in line:
            fill = OK
        elif line.startswith("Contract:") or line.startswith("Conversation:") or line.startswith("Path:"):
            fill = MUTED
        draw.text((PADDING, y), line, font=body_font, fill=fill)
        y += LINE_HEIGHT
    return image


def main() -> None:
    rows = CAST.read_text().splitlines()
    header = json.loads(rows[0])
    title = header.get("title", "AgentLink demo")
    buffer: list[str] = []
    frames: list[Image.Image] = []
    durations: list[int] = []
    last_time = 0.0

    for row in rows[1:]:
        timestamp, kind, payload = json.loads(row)
        if kind != "o":
            continue
        append_wrapped(buffer, payload)
        frames.append(draw_frame(buffer, title))
        delay = max(220, min(1400, int((float(timestamp) - last_time) * 1000)))
        durations.append(delay)
        last_time = float(timestamp)

    # Hold the last frame briefly so readers can absorb the result.
    if frames:
        durations[-1] = 2000
        GIF.parent.mkdir(parents=True, exist_ok=True)
        frames[0].save(
            GIF,
            save_all=True,
            append_images=frames[1:],
            duration=durations,
            loop=0,
            optimize=True,
        )
    print(GIF)
    print(GIF.stat().st_size)


if __name__ == "__main__":
    main()
