'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

// Per-platform "run at login" without admin rights:
//   Windows: hidden-window VBS launcher in the user's Startup folder
//   macOS:   launchd user agent
//   Linux:   systemd user unit, falling back to an XDG autostart .desktop
const BIN = path.join(__dirname, '..', 'bin', 'membridge.js');

function winStartupPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'MemBridge.vbs');
}
const macPlistPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.membridge.daemon.plist');
const linuxUnitPath = () => path.join(os.homedir(), '.config', 'systemd', 'user', 'membridge.service');
const linuxDesktopPath = () => path.join(os.homedir(), '.config', 'autostart', 'membridge.desktop');

function quiet(cmd) {
  try {
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function enable() {
  const node = process.execPath;
  if (process.platform === 'win32') {
    const file = winStartupPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `CreateObject("WScript.Shell").Run """${node}"" """${BIN}"" daemon", 0, False\r\n`);
    return `Autostart enabled: ${file}\nMemBridge will start hidden at every login.`;
  }
  if (process.platform === 'darwin') {
    const file = macPlistPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.membridge.daemon</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${BIN}</string><string>daemon</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict></plist>
`);
    quiet(`launchctl unload "${file}"`);
    quiet(`launchctl load "${file}"`);
    return `Autostart enabled: ${file}`;
  }
  // linux and friends
  if (fs.existsSync('/run/systemd/system')) {
    const file = linuxUnitPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `[Unit]
Description=MemBridge - shared memory across AI coding tools

[Service]
ExecStart=${node} ${BIN} daemon
Restart=on-failure

[Install]
WantedBy=default.target
`);
    quiet('systemctl --user daemon-reload');
    quiet('systemctl --user enable --now membridge.service');
    return `Autostart enabled: ${file} (systemd user unit)`;
  }
  const file = linuxDesktopPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `[Desktop Entry]
Type=Application
Name=MemBridge
Exec=${node} ${BIN} daemon
X-GNOME-Autostart-enabled=true
`);
  return `Autostart enabled: ${file} (XDG autostart)`;
}

function disable() {
  const removed = [];
  const tryRemove = f => {
    if (fs.existsSync(f)) {
      fs.unlinkSync(f);
      removed.push(f);
    }
  };
  if (process.platform === 'win32') {
    tryRemove(winStartupPath());
  } else if (process.platform === 'darwin') {
    quiet(`launchctl unload "${macPlistPath()}"`);
    tryRemove(macPlistPath());
  } else {
    quiet('systemctl --user disable --now membridge.service');
    tryRemove(linuxUnitPath());
    tryRemove(linuxDesktopPath());
  }
  return removed.length ? `Autostart disabled (removed ${removed.join(', ')})` : 'Autostart was not enabled.';
}

function isEnabled() {
  if (process.platform === 'win32') return fs.existsSync(winStartupPath());
  if (process.platform === 'darwin') return fs.existsSync(macPlistPath());
  return fs.existsSync(linuxUnitPath()) || fs.existsSync(linuxDesktopPath());
}

module.exports = { enable, disable, isEnabled };
