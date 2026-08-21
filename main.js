const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

let win;

function createWindow() {
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
  const width = 300;
  const height = 460;

  win = new BrowserWindow({
    width,
    height,
    x: sw - width - 24,
    y: 24,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.on('widget:close', () => app.quit());
ipcMain.on('widget:minimize', () => win && win.minimize());

app.whenReady().then(createWindow);

app.on('window-all-closed', () => app.quit());
