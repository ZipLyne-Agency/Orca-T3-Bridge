#!/usr/bin/env python3
"""Ephemeral signing setup for GitHub-hosted macOS. Temporary key material is removed and credential-tool diagnostics stay private."""
import base64
import os
from pathlib import Path
import secrets
import subprocess
import tempfile


def run(*args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, timeout=1800, **kwargs)


def main():
    if os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted':
        raise SystemExit('Signing workflow requires a disposable GitHub-hosted runner')
    with tempfile.TemporaryDirectory(prefix='bridge-signing-', dir=os.environ['RUNNER_TEMP']) as temporary:
        folder = Path(temporary)
        keychain = folder / 'signing.keychain-db'
        previous = run('security', 'list-keychains', '-d', 'user', capture_output=True, text=True).stdout
        original = [line.strip().strip('"') for line in previous.splitlines() if line.strip()]
        password = secrets.token_urlsafe(32)
        cert = folder / 'signing.p12'; cert.write_bytes(base64.b64decode(os.environ.pop('SIGNING_P12'), validate=True)); cert.chmod(0o600)
        notary_value = os.environ.pop('NOTARY_KEY')
        sparkle_value = os.environ.pop('SPARKLE_PRIVATE_KEY')
        try:
            run('security', 'create-keychain', '-p', password, keychain, capture_output=True)
            run('security', 'set-keychain-settings', '-lut', '1800', keychain, capture_output=True)
            run('security', 'unlock-keychain', '-p', password, keychain, capture_output=True)
            run('security', 'import', cert, '-k', keychain, '-P', os.environ.pop('SIGNING_PASSWORD'), '-T', '/usr/bin/codesign', capture_output=True)
            run('security', 'set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain, capture_output=True)
            run('security', 'list-keychains', '-d', 'user', '-s', keychain, *original, capture_output=True)
            env = os.environ.copy()
            run('python3', 'scripts/sign-macos.py', Path(env['BRIDGE_OUTPUT']) / 'Orca T3 Bridge.app', env=env)
            notary = folder / 'notary.p8'; notary.touch(mode=0o600); notary.write_text(notary_value)
            env['NOTARY_API_KEY_FILE'] = str(notary); env['SPARKLE_PRIVATE_KEY'] = sparkle_value
            run('python3', 'scripts/release-macos.py', '--prepared', '--publish', env=env)
        finally:
            run('security', 'list-keychains', '-d', 'user', '-s', *original, capture_output=True)
            subprocess.run(['security', 'delete-keychain', str(keychain)], capture_output=True, timeout=20)


if __name__ == '__main__':
    try: main()
    except subprocess.TimeoutExpired:
        raise SystemExit('Release command exceeded its deadline.') from None
    except subprocess.CalledProcessError as error:
        # CalledProcessError embeds argv, which may contain keychain passwords.
        raise SystemExit(f'Release command failed with exit status {error.returncode}; inspect the preceding non-secret output.') from None
