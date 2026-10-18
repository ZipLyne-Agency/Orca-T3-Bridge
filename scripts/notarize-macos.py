#!/usr/bin/env python3
"""Notarize the app, package a DMG and ZIP, and sign the Sparkle feed. Never publishes."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
REPO = 'ZipLyne-Agency/orca-t3-bridge'
ACCOUNT = 'agency.ziplyne.orca-t3.updates'


def run(*args, timeout=180, capture=False):
    result = subprocess.run([str(a) for a in args], check=True, timeout=timeout,
                            stdout=subprocess.PIPE if capture else None, text=True)
    return result.stdout if capture else None


def main():
    private_update_key = os.environ.pop('SPARKLE_PRIVATE_KEY', None)
    app = Path(sys.argv[1]).resolve(strict=True)
    output = app.parent
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    version = info['CFBundleShortVersionString']
    identity = os.environ['BRIDGE_SIGNING_IDENTITY']
    team = os.environ['BRIDGE_TEAM_ID']
    if identity == '-': raise SystemExit('A Developer ID signature is required for distribution')
    if os.environ.get('NOTARY_PROFILE'):
        auth = ['--keychain-profile', os.environ['NOTARY_PROFILE']]
    else:
        auth = ['--key', os.environ['NOTARY_API_KEY_FILE'], '--key-id', os.environ['NOTARY_KEY_ID'], '--issuer', os.environ['NOTARY_ISSUER']]
    run('codesign', '--verify', '--deep', '--strict', '-R', f'=anchor apple generic and certificate leaf[subject.OU] = "{team}"', app)
    with tempfile.TemporaryDirectory(prefix='bridge-notary-', dir=output) as temp:
        stage = Path(temp)
        submission = stage / 'submission.zip'
        run('ditto', '-c', '-k', '--keepParent', app, submission)

        def notarize(path, label):
            raw = run('xcrun', 'notarytool', 'submit', path, *auth, '--wait', '--timeout', '5m', '--output-format', 'json', timeout=360, capture=True)
            result = json.loads(raw)
            (output / f'notarization-{label}.json').write_text(json.dumps(result, indent=2) + '\n')
            print(f'Notarization {label}: {result.get("status")} ({result.get("id")})')
            if result.get('status') != 'Accepted': raise SystemExit('Apple did not accept the submission. Inspect its notary log before retrying.')
            return result

        notarize(submission, 'app')
        run('xcrun', 'stapler', 'staple', app); run('xcrun', 'stapler', 'validate', app)
        run('spctl', '--assess', '--type', 'execute', '--verbose', app)
        archive = output / f'Orca-T3-Bridge-{version}.zip'
        run('ditto', '-c', '-k', '--keepParent', app, archive)
        imageRoot = stage / 'image'; imageRoot.mkdir()
        run('ditto', app, imageRoot / app.name)
        (imageRoot / 'Applications').symlink_to('/Applications')
        dmg = output / f'Orca-T3-Bridge-{version}.dmg'
        run('hdiutil', 'create', '-volname', 'Orca T3 Bridge', '-srcfolder', imageRoot, '-format', 'UDZO', '-ov', dmg)
        run('codesign', '--force', '--sign', identity, '--timestamp', dmg)
        notarize(dmg, 'dmg')
        run('xcrun', 'stapler', 'staple', dmg); run('xcrun', 'stapler', 'validate', dmg)
        feeds = stage / 'feed'; feeds.mkdir()
        shutil.copy2(dmg, feeds / dmg.name)
        tools = ROOT / 'macos/.build/artifacts/sparkle/Sparkle/bin'
        key = ['--ed-key-file', os.environ['SPARKLE_KEY_FILE']] if os.environ.get('SPARKLE_KEY_FILE') else ['--account', ACCOUNT]
        if private_update_key:
            key_file = stage / 'update-signing.key'
            key_file.touch(mode=0o600)
            key_file.write_text(private_update_key)
            private_update_key = None
            key = ['--ed-key-file', str(key_file)]
        run(tools / 'generate_appcast', *key, '--download-url-prefix', f'https://github.com/{REPO}/releases/download/v{version}/',
            '--maximum-deltas', '0', '--versions', info['CFBundleVersion'], feeds)
        feed = output / 'appcast.xml'; shutil.copy2(feeds / 'appcast.xml', feed)
        run(tools / 'sign_update', '--verify', *key, feed)
        item = ET.parse(feed).find('./channel/item/enclosure')
        if item is None: raise SystemExit('Appcast enclosure missing')
        signature = item.get('{http://www.andymatuschak.org/xml-namespaces/sparkle}edSignature')
        if not signature: raise SystemExit('Update signature missing')
        run(tools / 'sign_update', '--verify', *key, dmg, signature)
        (output / 'SHA256SUMS').write_text(''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in [dmg, archive, feed]))
    print(f'Notarized release and signed appcast ready in {output}')


if __name__ == '__main__': main()
