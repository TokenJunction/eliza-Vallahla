ValOS Windows shell

These launchers use the same filenames as the earlier pack. They open the
public workstation at https://valhalla-app.xyz/os/ so a browser, a laptop,
and a full-time node stay on the same deployed desk.

  START-VALHALLA-OS.bat
  1-CLICK-INSTALL-AND-RUN.bat
  Install-and-Launch.bat
  ValhallaOS-Akershus-Setup.bat
  ValhallaOS-Akershus-Master-Installer.bat
  Update-ValhallaOS.bat
  Stop-ValhallaOS.bat

Sign-in is the public gate at /app/. These files do not put an email in the
URL. Update-ValhallaOS.bat reports the HTTP status and does not call the
site online unless that check is 200. Stop-ValhallaOS.bat only stops leftover
local bun.exe windows. It does not change the website.

Optional node label, not a cluster map:
  set VALOS_NODE=laptop
  set VALOS_NODE=full-time

The desk installer accepts tar, tar.gz, tgz, and zip packs with valos-app.json.
A Flatpak is not turned into a Bun app. If the archive also contains a ValOS
entry, only that entry can be installed. Otherwise the installer fails closed.

These notes are for the owner pack. They are not linked from the public homepage.
Original shell text. SPDX-License-Identifier: MIT
