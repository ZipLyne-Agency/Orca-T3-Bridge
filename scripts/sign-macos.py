#!/usr/bin/env python3
"""Sign an already assembled bundle without running its code or build tools."""
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile


def main():
    app = Path(sys.argv[1]).resolve(strict=True)
    identity = os.environ.get('BRIDGE_SIGNING_IDENTITY', '-')
    contents = app / 'Contents'
    # Only this script and Apple's signing tool run after CI unlocks the keychain.
    with tempfile.TemporaryDirectory(prefix='bridge-sign-', dir=app.parent) as temporary:
        jit = Path(temporary) / 'node-entitlements.plist'
        jit.write_bytes(plistlib.dumps({'com.apple.security.cs.allow-jit': True,
                                       'com.apple.security.cs.allow-unsigned-executable-memory': True}))
        def sign(path, entitlements=None, preserve=False):
            args = ['codesign', '--force', '--sign', identity]
            if identity != '-': args += ['--options', 'runtime', '--timestamp']
            if preserve: args += ['--preserve-metadata=entitlements']
            if entitlements: args += ['--entitlements', str(entitlements)]
            subprocess.run([*args, str(path)], check=True, timeout=120)
        for arch in ['arm64', 'x64']: sign(contents / f'MacOS/node-{arch}', entitlements=jit)
        framework = contents / 'Frameworks/Sparkle.framework'
        internal = framework / 'Versions/B'
        for name in ['Installer', 'Downloader']: sign(internal / f'XPCServices/{name}.xpc', preserve=True)
        sign(internal / 'Autoupdate', preserve=True); sign(internal / 'Updater.app', preserve=True)
        sign(framework); sign(app)
        subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True, timeout=60)


if __name__ == '__main__': main()
