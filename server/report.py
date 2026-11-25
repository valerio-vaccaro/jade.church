"""Export flow runs as a zipped, self-contained HTML report.

The zip holds one folder:

    jade.church-report-<timestamp>/
        index.html            summary table + one section per run (steps, errors,
                              screenshots, flow source); no external resources
        <run dir>/run.json    the run record, as stored by the server
        <run dir>/*.png       the run's screenshots, referenced by index.html

Unzip it and open index.html in any browser (works offline, from file://).
"""
import html
import io
import json
import os
import time
import zipfile

ICONS = {'passed': '✓', 'failed': '✗', 'stopped': '■', 'cancelled': '⊘', 'running': '…', 'error': '✗'}

CSS = """
:root { --bg:#0f1115; --card:#171a21; --line:#2a2f3a; --fg:#e6e6e6; --muted:#8b93a3;
  --ok:#2fbf71; --bad:#e5534b; --warn:#e3b341;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
@media (prefers-color-scheme: light) {
  :root { --bg:#f6f7f9; --card:#fff; --line:#dde1e7; --fg:#1d2330; --muted:#5d6676; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg);
  font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 20px 60px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 17px; margin: 0; display:flex; gap:10px; align-items:baseline; flex-wrap:wrap; }
.muted { color: var(--muted); }
.totals { display:flex; gap:18px; margin: 14px 0 20px; flex-wrap: wrap; }
.totals div { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px 14px; min-width:110px; }
.totals b { display:block; font-size: 22px; font-variant-numeric: tabular-nums; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align:left; padding: 5px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 12px; }
td.num { text-align: right; }
td.nw { white-space: nowrap; }
a { color: inherit; }
.passed { color: var(--ok); } .failed, .error, .stopped, .cancelled { color: var(--bad); } .running { color: var(--warn); }
section.run { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin: 18px 0; }
.warnline { color: var(--warn); margin: 6px 0 0; }
.err { color: var(--bad); font-family: var(--mono); white-space: pre-wrap; margin: 8px 0 0; }
details { margin-top: 10px; }
summary { cursor: pointer; color: var(--muted); }
.steps td { font-family: var(--mono); font-size: 12.5px; }
.steps td.detail { color: var(--muted); word-break: break-all; max-width: 520px; }
.gallery { display:flex; flex-wrap:wrap; gap:12px; margin: 4px 0 8px; }
tr.shots td { border-bottom: 0; }
tr.exp-passed td:nth-child(n+3) { color: var(--ok); }
tr.fwe td { color: var(--warn); font-family: var(--mono); font-size: 12.5px; }
tr.exp-failed td:nth-child(n+3) { color: var(--bad); }
.gallery figure { margin:0; }
.gallery img { display:block; width: 320px; max-width: 100%; image-rendering: pixelated;
  border:1px solid var(--line); border-radius:4px; background:#000; }
.gallery figcaption { font-size: 12px; color: var(--muted); font-family: var(--mono); }
pre.src { font-family: var(--mono); font-size: 12.5px; background: var(--bg); border:1px solid var(--line);
  border-radius:6px; padding: 10px; overflow:auto; max-height: 480px; }
"""


def _e(value):
    return html.escape('' if value is None else str(value))


def _when(ts):
    return time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(ts)) if ts else ''


def fw_short(fw):
    """'Jade v2 1.0.41-220-ga59d14c2' (+ ' CI' for auto-confirm builds), or '' when unknown."""
    if not fw:
        return ''
    board = {'jade-v1': 'Jade v1', 'jade-v2': 'Jade v2'}.get(fw.get('board'), fw.get('board') or '')
    return ' '.join(x for x in (board, fw.get('jade_version') or '', 'CI' if fw.get('ci') else '') if x)


def _run_section(rec):
    d = rec['dir']
    status = rec.get('status') or ''
    suite = rec.get('suite') or {}
    counts = ', '.join(f'{n} {k}' for k, n in (rec.get('steps') or {}).items())
    out = [f'<section class="run" id="{_e(d)}">',
           f'<h2><span class="{_e(status)}">{ICONS.get(status, "")} {_e(status)}</span> {_e(rec.get("name"))}'
           f'<span class="muted">{_e(_when(rec.get("started")))} · {_e(rec.get("seconds"))} s · '
           f'{_e(rec.get("steps_total"))} steps{" (" + _e(counts) + ")" if counts else ""}</span></h2>']
    if suite:
        out.append(f'<div class="muted">suite “{_e(suite.get("name"))}”, flow {_e(suite.get("index"))}'
                   f' of {_e(suite.get("total"))}</div>')
    if rec.get('file'):
        out.append(f'<div class="muted">file: {_e(rec["file"])}</div>')
    fw = rec.get('firmware') or {}
    if fw:
        out.append(f'<div class="muted">firmware: {_e(fw.get("label"))} ({_e(fw.get("file"))})</div>')
    if rec.get('error'):
        out.append(f'<p class="err">{_e(rec["error"])}</p>')
    if rec.get('firmware_errors'):
        out.append(f'<p class="warnline">⚠ the firmware logged {rec["firmware_errors"]} error(s) during this run</p>')

    records = rec.get('records') or []

    def gallery(paths):
        items = []
        for p in paths:
            rel = p if p.startswith(d + '/') else f'{d}/{p}'
            items.append(f'<figure><a href="{_e(rel)}"><img loading="lazy" src="{_e(rel)}" '
                         f'alt="{_e(os.path.basename(rel))}"></a><figcaption>{_e(os.path.basename(rel))}</figcaption></figure>')
        return '<div class="gallery">' + ''.join(items) + '</div>'

    shown = set()
    if records:
        bad = sum(1 for r in records if r.get('status') not in ('passed', 'running'))
        has_shots = any(r.get('screenshots') or r.get('firmware_errors') for r in records)
        out.append(f'<details{" open" if bad or has_shots else ""}><summary>{len(records)} steps</summary>'
                   '<table class="steps"><tr><th>line</th><th></th><th>step</th><th>result</th></tr>')
        for r in records:
            st = r.get('status') or ''
            detail = r.get('detail')
            if detail is not None and not isinstance(detail, str):
                detail = json.dumps(detail)
            if detail and len(detail) > 600:
                detail = detail[:600] + '…'
            expect = str(r.get('text') or '').startswith('expect')    # checks: green / red
            cls = f' class="exp-{_e(st)}"' if expect else ''
            out.append(f'<tr{cls}><td class="num">{_e(r.get("line"))}</td><td class="{_e(st)}">{ICONS.get(st, "")}</td>'
                       f'<td>{_e(r.get("text"))}</td><td class="detail">{_e(detail)}</td></tr>')
            for fe in r.get('firmware_errors') or []:   # errors the firmware logged during the step
                out.append(f'<tr class="fwe"><td></td><td>⚠</td><td colspan="2">firmware error: {_e(fe)}</td></tr>')
            if r.get('screenshots'):                    # images under the step that took them
                out.append(f'<tr class="shots"><td></td><td></td><td colspan="2">{gallery(r["screenshots"])}</td></tr>')
                shown.update(r['screenshots'])
        out.append('</table></details>')
    rest = [p for p in rec.get('screenshots') or [] if p not in shown]
    if rest:
        out.append(gallery(rest))
    if rec.get('source'):
        out.append(f'<details><summary>flow source</summary><pre class="src">{_e(rec["source"])}</pre></details>')
    out.append(f'<details><summary>files</summary><a href="{_e(d)}/run.json">{_e(d)}/run.json</a></details>')
    out.append('</section>')
    return '\n'.join(out)


def build_html(records, title):
    totals = {}
    for r in records:
        totals[r.get('status') or '?'] = totals.get(r.get('status') or '?', 0) + 1
    steps = sum(r.get('steps_total') or 0 for r in records)
    seconds = sum(r.get('seconds') or 0 for r in records)
    rows = []
    for r in records:
        st = r.get('status') or ''
        rows.append(f'<tr><td class="nw {_e(st)}">{ICONS.get(st, "")} {_e(st)}</td>'
                    f'<td><a href="#{_e(r["dir"])}">{_e(r.get("name"))}</a></td>'
                    f'<td class="nw">{_e(fw_short(r.get("firmware")))}</td>'
                    f'<td class="nw">{_e(_when(r.get("started")))}</td><td class="num">{_e(r.get("seconds"))}</td>'
                    f'<td class="num">{_e(r.get("steps_total"))}</td>'
                    f'<td class="num">{len(r.get("screenshots") or [])}</td>'
                    f'<td class="err" style="margin:0">{_e((r.get("error") or "")[:160])}</td></tr>')
    cards = ''.join(f'<div><b class="{_e(k)}">{n}</b>{_e(k)}</div>' for k, n in sorted(totals.items()))
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{_e(title)}</title><style>{CSS}</style></head>
<body><main>
<h1>{_e(title)}</h1>
<div class="muted">Exported from jade.church on {_e(_when(time.time()))} · {len(records)} run(s)</div>
<div class="totals"><div><b>{len(records)}</b>runs</div>{cards}<div><b>{steps}</b>steps</div>
<div><b>{round(seconds, 1)}</b>seconds</div></div>
<table><tr><th>status</th><th>flow</th><th>firmware</th><th>started</th><th>s</th><th>steps</th><th>shots</th><th>error</th></tr>
{''.join(rows)}</table>
{''.join(_run_section(r) for r in records)}
</main></body></html>
"""


def export_zip(runs_dir, names):
    """Zip the named run folders (oldest first) plus an index.html report. Returns (bytes, filename)."""
    records = []
    for name in names:
        try:
            with open(os.path.join(runs_dir, name, 'run.json'), encoding='utf-8') as f:
                rec = json.load(f)
        except (OSError, ValueError):
            continue
        rec['dir'] = name
        records.append(rec)
    if not records:
        raise ValueError('no runs to export')
    records.sort(key=lambda r: r.get('started') or 0)
    stamp = time.strftime('%Y%m%d-%H%M%S')
    root = f'jade.church-report-{stamp}'
    title = (f'jade.church run: {records[0].get("name")}' if len(records) == 1
             else f'jade.church runs ({len(records)})')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr(f'{root}/index.html', build_html(records, title))
        for rec in records:
            folder = os.path.join(runs_dir, rec['dir'])
            for fname in sorted(os.listdir(folder)):
                full = os.path.join(folder, fname)
                if os.path.isfile(full) and not os.path.islink(full):
                    # PNGs are already compressed
                    z.write(full, f'{root}/{rec["dir"]}/{fname}',
                            zipfile.ZIP_STORED if fname.endswith('.png') else zipfile.ZIP_DEFLATED)
    return buf.getvalue(), root + '.zip'
