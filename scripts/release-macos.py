#!/usr/bin/env python3
"""Build, notarize, and optionally publish from a clean tagged source checkout."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import plistlib
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
REPO = 'ZipLyne-Agency/orca-t3-bridge'


def run(*args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, cwd=ROOT, timeout=1800, **kwargs)


def main():
    private_update_key = os.environ.pop('SPARKLE_PRIVATE_KEY', None)
    parser = argparse.ArgumentParser()
    parser.add_argument('--publish', action='store_true')
    parser.add_argument('--prepared', action='store_true', help='Use the CI bundle assembled before signing secrets are injected')
    args = parser.parse_args()
    release = json.loads((ROOT / 'release/version.json').read_text())
    version = release['version']
    package = json.loads((ROOT / 'package.json').read_text())['version']
    if version != package: raise SystemExit('Native and CLI versions must match')
    if args.publish:
        if run('git', 'status', '--porcelain', capture_output=True, text=True).stdout.strip():
            raise SystemExit('Publish requires a clean checkout')
        head = run('git', 'rev-parse', 'HEAD', capture_output=True, text=True).stdout.strip()
        tag = run('git', 'rev-parse', f'v{version}^{{commit}}', capture_output=True, text=True).stdout.strip()
        if head != tag: raise SystemExit('Publish requires the matching release tag at HEAD')
        latest = json.loads(run('gh', 'api', f'repos/{REPO}/releases/latest', capture_output=True, text=True).stdout)
        if any(asset['name'] == 'appcast.xml' for asset in latest['assets']):
            with tempfile.TemporaryDirectory(prefix='bridge-prior-feed-') as temporary:
                run('gh', 'release', 'download', latest['tag_name'], '--repo', REPO, '--pattern', 'appcast.xml', '--dir', temporary)
                feed = ET.parse(Path(temporary) / 'appcast.xml')
                prior = [node.text for node in feed.iter('{http://www.andymatuschak.org/xml-namespaces/sparkle}version')]
                if not prior or any(not value or not value.isdigit() for value in prior):
                    raise SystemExit('Cannot establish the previous Sparkle build number')
                if int(release['build']) <= max(map(int, prior)):
                    raise SystemExit('The release build must be higher than the latest Sparkle build')
    output = Path(os.environ.get('BRIDGE_OUTPUT', str(Path.home() / 'Assets/orca-t3-bridge/files/macos'))).resolve()
    env = os.environ.copy(); env['BRIDGE_OUTPUT'] = str(output)
    if not args.prepared:
        run('bash', 'scripts/build-macos.sh', env=env)
        run('npm', 'pack', '--pack-destination', output)
    app_info = plistlib.loads((output / 'Orca T3 Bridge.app/Contents/Info.plist').read_bytes())
    if app_info['CFBundleShortVersionString'] != version or app_info['CFBundleVersion'] != release['build']:
        raise SystemExit('Prepared app version does not match release metadata')
    if not (output / f'orca-t3-bridge-{version}.tgz').is_file():
        raise SystemExit('Prepared CLI archive is missing')
    if private_update_key: env['SPARKLE_PRIVATE_KEY'] = private_update_key
    run('python3', 'scripts/notarize-macos.py', output / 'Orca T3 Bridge.app', env=env)
    env.pop('SPARKLE_PRIVATE_KEY', None)
    if args.publish:
        notes = ROOT / 'release/notes.md'
        # Draft first: a partial upload can never replace the live Sparkle feed.
        run('gh', 'release', 'create', f'v{version}', '--repo', REPO, '--verify-tag', '--draft',
            '--title', f'Orca T3 Bridge {version}', '--notes-file', notes,
            output / f'Orca-T3-Bridge-{version}.dmg', output / f'Orca-T3-Bridge-{version}.zip',
            output / 'appcast.xml', output / 'SHA256SUMS', output / f'orca-t3-bridge-{version}.tgz')
        run('gh', 'release', 'edit', f'v{version}', '--repo', REPO, '--draft=false', '--latest')


if __name__ == '__main__': main()
