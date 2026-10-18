#!/usr/bin/env python3
"""Package a self-contained universal app. Signing keys remain outside the source tree."""
import base64
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
NAME = 'Orca T3 Bridge'
FEED = 'https://github.com/ZipLyne-Agency/orca-t3-bridge/releases/latest/download/appcast.xml'


def run(*args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, timeout=180, **kwargs)


def node_runtime(arch, cache, metadata):
    name = f'node-v{metadata["version"]}-darwin-{arch}.tar.gz'
    archive = cache / name
    if not archive.exists():
        with urllib.request.urlopen(f'https://nodejs.org/dist/v{metadata["version"]}/{name}', timeout=60) as response:
            with archive.open('wb') as output:
                total = 0
                while block := response.read(1024 * 1024):
                    total += len(block)
                    if total > 100 * 1024 * 1024:
                        raise RuntimeError('Node archive exceeds download limit')
                    output.write(block)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != metadata[arch]:
        raise RuntimeError('Node archive checksum does not match the pinned release')
    return archive


def main():
    binary = Path(sys.argv[1]).resolve(strict=True)
    output = Path(sys.argv[2]).expanduser().resolve()
    if output == Path('/Applications'):
        raise SystemExit('Build into an artifact directory, then install the verified app.')
    output.mkdir(parents=True, exist_ok=True)
    cache = output / 'cache'; cache.mkdir(exist_ok=True)
    release = json.loads((ROOT / 'release/version.json').read_text())
    version = os.environ.get('BRIDGE_VERSION', release['version'])
    build = os.environ.get('BRIDGE_BUILD', release['build'])
    if not re.fullmatch(r'\d+\.\d+\.\d+', version) or not re.fullmatch(r'[1-9]\d*', build):
        raise SystemExit('Invalid app version or build number')
    key = (ROOT / 'release/sparkle-public-key.txt').read_text().strip()
    if len(base64.b64decode(key, validate=True)) != 32:
        raise SystemExit('Invalid public update key')
    identity = os.environ.get('BRIDGE_SIGNING_IDENTITY', '-')
    framework = ROOT / 'macos/.build/artifacts/sparkle/Sparkle/Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework'
    runtime = json.loads((ROOT / 'release/runtime.json').read_text())
    with tempfile.TemporaryDirectory(prefix='bridge-package-', dir=output) as temporary:
        stage = Path(temporary)
        bundle = stage / f'{NAME}.app'; contents = bundle / 'Contents'
        resources = contents / 'Resources'
        (contents / 'MacOS').mkdir(parents=True); resources.mkdir(); (contents / 'Frameworks').mkdir()
        shutil.copy2(binary, contents / 'MacOS/OrcaT3')
        embedded = contents / 'Frameworks/Sparkle.framework'
        run('ditto', framework, embedded)
        for arch in ['arm64', 'x64']:
            archive = node_runtime(arch, cache, runtime)
            with tarfile.open(archive) as tar:
                prefix = f'node-v{runtime["version"]}-darwin-{arch}'
                node = contents / f'MacOS/node-{arch}'
                node.write_bytes(tar.extractfile(f'{prefix}/bin/node').read()); node.chmod(0o755)
                if arch == 'arm64':
                    (resources / 'Node-LICENSE').write_bytes(tar.extractfile(f'{prefix}/LICENSE').read())
        package = resources / 'bridge'; package.mkdir()
        for name in ['package.json', 'npm-shrinkwrap.json']:
            shutil.copy2(ROOT / name, package / name)
        shutil.copytree(ROOT / 'dist/src', package / 'dist/src')
        run('npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', cwd=package)
        for source, dest in [(ROOT / 'LICENSE', 'Bridge-LICENSE'),
                             (ROOT / 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'),
                             (ROOT / 'macos/.build/checkouts/Sparkle/LICENSE', 'Sparkle-LICENSE')]:
            shutil.copy2(source, resources / dest)
        info = {
            'CFBundleIdentifier': 'agency.ziplyne.orca-t3-bridge', 'CFBundleName': NAME,
            'CFBundleDisplayName': NAME, 'CFBundleExecutable': 'OrcaT3', 'CFBundlePackageType': 'APPL',
            'CFBundleShortVersionString': version, 'CFBundleVersion': build,
            'LSMinimumSystemVersion': '13.0', 'LSUIElement': True, 'NSHighResolutionCapable': True,
            'CFBundleIconFile': 'AppIcon', 'LSApplicationCategoryType': 'public.app-category.developer-tools',
            'NSHumanReadableCopyright': 'Copyright 2026 ZipLyne',
            'SUFeedURL': FEED, 'SUPublicEDKey': key, 'SURequireSignedFeed': True,
            'SUVerifyUpdateBeforeExtraction': True, 'SUSignedFeedFailureExpirationInterval': 0,
            'SUEnableAutomaticChecks': True, 'SUAutomaticallyUpdate': True,
            'SUScheduledCheckInterval': 86400, 'SUEnableSystemProfiling': False, 'SUSendProfileInfo': False,
        }
        (contents / 'Info.plist').write_bytes(plistlib.dumps(info))
        iconset = stage / 'AppIcon.iconset'; iconset.mkdir()
        run('swift', ROOT / 'scripts/make-app-icon.swift', iconset)
        run('iconutil', '-c', 'icns', iconset, '-o', resources / 'AppIcon.icns')
        run('python3', ROOT / 'scripts/sign-macos.py', bundle)
        # Smoke the actual bundled Node and sealed runtime, without app or provider access.
        machine = 'arm64' if os.uname().machine == 'arm64' else 'x64'
        run(contents / f'MacOS/node-{machine}', package / 'dist/src/cli.js', 'doctor', '--offline')
        final = output / f'{NAME}.app'
        if final.is_symlink(): raise SystemExit('Refusing to replace a symlinked app')
        if final.exists(): shutil.rmtree(final)
        shutil.move(str(bundle), final)
    print(f'Packaged {final} ({version}, build {build})')


if __name__ == '__main__': main()
