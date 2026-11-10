const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const names = [
  'START-VALHALLA-OS.bat',
  '1-CLICK-INSTALL-AND-RUN.bat',
  'Install-and-Launch.bat',
  'ValhallaOS-Akershus-Setup.bat',
  'ValhallaOS-Akershus-Master-Installer.bat',
  'Update-ValhallaOS.bat',
  'Stop-ValhallaOS.bat'
];

test('Windows launchers keep their names and do not bypass sign-in', () => {
  const home = fs.readFileSync(path.join(root, 'website/index.html'), 'utf8');
  assert.doesNotMatch(home, /START-VALHALLA-OS/);
  for (const name of names) {
    const text = fs.readFileSync(path.join(root, 'windows-shell', name), 'utf8');
    if (name !== 'Stop-ValhallaOS.bat') {
      assert.match(text, /valhalla-app\.xyz\/os\/|START-VALHALLA-OS\.bat|Install-and-Launch\.bat/);
    }
    assert.doesNotMatch(text, /auth=|operator-01@|keene\.jos|pk_test_|decrypt enclave|14\.85|3DES/i);
    assert.doesNotMatch(text, /server is online|Welcome Home/i);
  }
  assert.match(fs.readFileSync(path.join(root, 'windows-shell/START-VALHALLA-OS.bat'), 'utf8'), /https:\/\/valhalla-app\.xyz\/os\//);
  const update = fs.readFileSync(path.join(root, 'windows-shell/Update-ValhallaOS.bat'), 'utf8');
  assert.match(update, /HTTP %VALOS_CODE%/);
  assert.match(update, /exit \/b 1/);
  const stop = fs.readFileSync(path.join(root, 'windows-shell/Stop-ValhallaOS.bat'), 'utf8');
  assert.match(stop, /bun\.exe/);
  assert.match(stop, /public website is unchanged/);
});
