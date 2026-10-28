"""Bounded native launch on a fresh GitHub build Mac; no user data or AI calls."""
import json
import os
import plistlib
import subprocess
import time
from pathlib import Path

if not os.environ.get('GITHUB_ACTIONS') == 'true':
    raise SystemExit('Native smoke is restricted to the task GitHub runner')
bundle = Path(os.environ['CARGO_TARGET_DIR']) / 'universal-apple-darwin/release/bundle/macos/Lumen.app'
with (bundle / 'Contents/Info.plist').open('rb') as stream:
    info = plistlib.load(stream)
executable = bundle / 'Contents/MacOS' / info['CFBundleExecutable']
output = Path('mac-ui-evidence')
output.mkdir(exist_ok=True)
report = {'sourceCommit': os.environ['GITHUB_SHA'], 'environment': 'fresh GitHub macos-15 runner',
          'nativeLaunch': False, 'nativeInteractionVerified': False, 'realProviderCalls': 0}
if (Path.home() / 'Library/Application Support/Lumen/config.json').exists():
    raise SystemExit('Expected a clean runner with no existing Lumen storage or credentials')
with (output / 'mac-native-startup.log').open('wb') as log:
    process = subprocess.Popen([str(executable)], stdout=log, stderr=subprocess.STDOUT)
    try:
        time.sleep(8)
        report['pid'] = process.pid
        report['nativeLaunch'] = process.poll() is None
        if not report['nativeLaunch']:
            raise RuntimeError('The built native Mac app exited during startup')
        screenshot = subprocess.run(['/usr/sbin/screencapture', '-x', str(output / 'mac-native-startup.png')], capture_output=True)
        report['screenshotCaptured'] = screenshot.returncode == 0 and (output / 'mac-native-startup.png').exists()
        if screenshot.returncode:
            report['screenshotLimitation'] = screenshot.stderr.decode(errors='replace')[:400]
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=15)
        report['processStopped'] = process.poll() is not None
        (output / 'mac-native-smoke.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report))
