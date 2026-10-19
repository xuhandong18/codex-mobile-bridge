#!/usr/bin/env python3
"""Install a local-test APK and run synthetic notification checks on an explicitly selected emulator."""
import argparse
import os
from pathlib import Path
import re
import subprocess
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--serial', required=True)
parser.add_argument('--apk', required=True, type=Path)
parser.add_argument('--classes-dir', required=True, type=Path, help='Classes compiled from the same sources as the APK')
parser.add_argument('--sdk', type=Path, default=os.environ.get('ANDROID_SDK_ROOT') or os.environ.get('ANDROID_HOME'))
args = parser.parse_args()
if not re.fullmatch(r'emulator-\d+', args.serial):
    parser.error('Use an isolated Android emulator; physical devices are not accepted.')
windows = os.name == 'nt'
sdk = args.sdk or ((Path(os.environ['LOCALAPPDATA']) / 'Android/Sdk') if windows else Path.home() / 'Android/Sdk')
jdk = Path(os.environ['JAVA_HOME'])
exe = '.exe' if windows else ''
batch = '.bat' if windows else ''
tools = sorted((sdk / 'build-tools').iterdir(), key=lambda p: tuple(int(n) for n in re.findall(r'\d+', p.name)))[-1]
android = sdk / 'platforms/android-35/android.jar'
work = ROOT / ('.tmp/android-notification-flow-' + uuid.uuid4().hex[:8])
for folder in ('classes', 'dex'):
    (work / folder).mkdir(parents=True, exist_ok=False)


def run(*command, capture=False):
    return subprocess.run([str(value) for value in command], cwd=ROOT, check=True,
                          capture_output=capture, text=True, encoding='utf-8' if capture else None)


badging = run(tools / ('aapt2' + exe), 'dump', 'badging', args.apk.resolve(), capture=True).stdout
if "package: name='io.github.try2love.codexbridge.localtest'" not in badging:
    parser.error('Only the separate local-test package is accepted; never replace the official app.')
manifest = '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="io.github.try2love.codexbridge.localtest.notificationchecks"><uses-sdk android:minSdkVersion="26" android:targetSdkVersion="35"/><application android:label="Notification checks"/><instrumentation android:name="io.github.try2love.codexbridge.NotificationFlowInstrumentation" android:targetPackage="io.github.try2love.codexbridge.localtest"/></manifest>'
(work / 'AndroidManifest.xml').write_text(manifest, encoding='utf-8')
run(tools / ('aapt2' + exe), 'link', '-I', android, '--manifest', work / 'AndroidManifest.xml', '-o', work / 'base.apk')
run(jdk / ('bin/javac' + exe), '-encoding', 'UTF-8', '--release', '8', '-classpath',
    str(android) + os.pathsep + str(args.classes_dir.resolve()), '-d', work / 'classes',
    ROOT / 'mobile/tests/NotificationFlowInstrumentation.java')
run(tools / ('d8' + batch), '--lib', android, '--min-api', '26', '--output', work / 'dex', *sorted((work / 'classes').rglob('*.class')))
(work / 'unsigned.apk').write_bytes((work / 'base.apk').read_bytes())
with zipfile.ZipFile(work / 'unsigned.apk', 'a') as archive:
    for dex in (work / 'dex').glob('*.dex'):
        archive.write(dex, dex.name)
run(tools / ('zipalign' + exe), '-f', '4', work / 'unsigned.apk', work / 'aligned.apk')
run(tools / ('apksigner' + batch), 'sign', '--ks', Path.home() / '.android/debug.keystore',
    '--ks-key-alias', 'androiddebugkey', '--ks-pass', 'pass:android', '--out', work / 'checks.apk', work / 'aligned.apk')
adb = sdk / ('platform-tools/adb' + exe)
run(adb, '-s', args.serial, 'install', '-r', '-g', args.apk.resolve())
run(adb, '-s', args.serial, 'install', '-r', '-g', work / 'checks.apk')
run(adb, '-s', args.serial, 'shell', 'input', 'keyevent', '82')
result = run(adb, '-s', args.serial, 'shell', 'am', 'instrument', '-w',
             'io.github.try2love.codexbridge.localtest.notificationchecks/io.github.try2love.codexbridge.NotificationFlowInstrumentation', capture=True)
print(result.stdout)
if 'PASS real APK/WebView notification flow: 9 assertions' not in result.stdout:
    raise SystemExit(1)
