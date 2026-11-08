from pathlib import Path
import shutil

out = Path('site-build')
if out.exists():
    shutil.rmtree(out)
shutil.copytree(
    '.',
    out,
    ignore=shutil.ignore_patterns(
        '.git', '.github', '.wrangler', '.vscode', '__pycache__', 'node_modules', 'site-build',
        'scripts',
        '.env', '.env.*', 'package.json', 'package-lock.json', 'bun.lock',
        'bun.lockb', 'render.yaml', 'valhalla-elizaos', 'supabase', 'lib',
        'valhallaQueueEngine.js', 'valhallaQueueEngine.test.cjs',
        'valhallaWorker.js', 'valhallaWorker.test.cjs', 'setup.ps1', 'setup.sh'
    )
)

# Authentication code is copied byte-for-byte, never weakened at build time.
assert (out / 'app/gate.js').read_bytes() == Path('app/gate.js').read_bytes()
errors = out / 'errors.js'
text = errors.read_text()
needle = "frame.title = 'Valhalla read-only preview';"
if needle in text:
    start = text.rfind('\n(function () {', 0, text.index(needle))
    assert start > 0
    text = text[:start] + '\n'
assert 'root.ValhallaErrors = ' in text
errors.write_text(text)

assert (out / 'assets/mark.svg').is_file()
assert (out / 'assets/mech.jpg').is_file()
assert (out / 'app/index.html').read_bytes() == Path('app/index.html').read_bytes()
