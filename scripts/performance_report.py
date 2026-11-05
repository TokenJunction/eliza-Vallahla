#!/usr/bin/env python3
"""Render a local Valhalla performance export as an SVG timing report."""

import argparse
import html
import json
import math
from pathlib import Path

COLORS = ("#16875c", "#b36b00", "#3276a8", "#bd4656")


def load_records(path):
    with Path(path).open(encoding="utf-8") as source:
        export = json.load(source)
    if not isinstance(export, dict) or export.get("version") != 1 or not isinstance(export.get("records"), list):
        raise ValueError("Expected a Valhalla performance export (version 1 with records).")
    rows = []
    for row in export["records"]:
        if not isinstance(row, dict) or row.get("status") not in ("ok", "error"):
            continue
        try:
            duration = float(row["durationMs"])
        except (KeyError, TypeError, ValueError):
            continue
        if not math.isfinite(duration) or duration < 0:
            continue
        rows.append({
            "model": str(row.get("provider", "unknown"))[:32] + " / " + str(row.get("model", "unreported"))[:80],
            "duration": duration,
            "status": row["status"],
            "at": str(row.get("at", ""))[:24],
        })
    return rows


def percentile(values, ratio):
    ordered = sorted(values)
    if not ordered:
        return 0
    index = max(0, math.ceil(len(ordered) * ratio) - 1)
    return ordered[index]


def render(rows):
    width, height = 800, 390
    success = [row for row in rows if row["status"] == "ok"][-30:]
    failures = sum(row["status"] == "error" for row in rows)
    models = list(dict.fromkeys(row["model"] for row in success))
    maximum = max([1000.0] + [row["duration"] for row in success])
    left, right, top, bottom = 78, 778, 48, 278
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" role="img" aria-labelledby="title description">',
        '<title id="title">Valhalla model response timings</title>',
        '<desc id="description">Successful response duration in milliseconds, grouped by the reported model. Failed request count is shown separately.</desc>',
        '<rect width="100%" height="100%" fill="#f7f5ef"/>',
        '<text x="24" y="30" font-family="sans-serif" font-size="18" font-weight="700" fill="#171717">Recent model response time · successful requests</text>',
    ]
    for index in range(3):
        ratio = index / 2
        y = bottom - (bottom - top) * ratio
        parts.append(f'<line x1="{left}" y1="{y:.1f}" x2="{right}" y2="{y:.1f}" stroke="#d7d2c8"/>')
        parts.append(f'<text x="{left - 10}" y="{y + 4:.1f}" text-anchor="end" font-family="sans-serif" font-size="11" fill="#45413a">{maximum * ratio:.0f} ms</text>')
    parts.append(f'<line x1="{left}" y1="{top}" x2="{left}" y2="{bottom}" stroke="#756d60"/>')
    parts.append(f'<line x1="{left}" y1="{bottom}" x2="{right}" y2="{bottom}" stroke="#756d60"/>')
    if success:
        step = (right - left) / len(success)
        for index, row in enumerate(success):
            bar_height = (row["duration"] / maximum) * (bottom - top)
            x = left + index * step + step * 0.18
            bar_width = max(2, step * 0.64)
            color = COLORS[models.index(row["model"]) % len(COLORS)]
            label = html.escape(f'{row["model"]} · {row["duration"]:.0f} ms · {row["at"]}', quote=True)
            parts.append(
                f'<rect x="{x:.1f}" y="{bottom - bar_height:.1f}" width="{bar_width:.1f}" '
                f'height="{max(1, bar_height):.1f}" fill="{color}"><title>{label}</title></rect>'
            )
        for index, model in enumerate(models):
            x = left + index * 250
            parts.append(f'<rect x="{x}" y="306" width="12" height="12" fill="{COLORS[index % len(COLORS)]}"/>')
            parts.append(f'<text x="{x + 18}" y="317" font-family="sans-serif" font-size="11" fill="#34312c">{html.escape(model)}</text>')
        all_times = [row["duration"] for row in success]
        summary = (f'{len(success)} successful samples · median {percentile(all_times, 0.5):.0f} ms'
                   f' · p95 {percentile(all_times, 0.95):.0f} ms · {failures} failed')
    else:
        parts.append('<text x="110" y="155" font-family="sans-serif" font-size="16" fill="#5f594f">No successful model timings to chart</text>')
        summary = f'0 successful samples · {failures} failed'
    parts.append(f'<text x="24" y="365" font-family="sans-serif" font-size="13" fill="#34312c">{html.escape(summary)}</text>')
    parts.append('<text x="24" y="385" font-family="sans-serif" font-size="10" fill="#625d54">Measurements are browser-to-service elapsed time, not provider-only inference time. No prompts or replies are included.</text>')
    parts.append("</svg>")
    return "\n".join(parts), summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="JSON file exported from the Valhalla performance panel")
    parser.add_argument("--output", default="valhalla-performance.svg", help="SVG report path")
    args = parser.parse_args()
    rows = load_records(args.input)
    svg, summary = render(rows)
    output = Path(args.output)
    output.write_text(svg, encoding="utf-8")
    print(f"{summary} · chart {output}")


if __name__ == "__main__":
    main()
