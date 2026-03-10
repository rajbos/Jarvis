import { Tray, Menu, nativeImage, app } from 'electron';
import path from 'path';

export function createTray(onOpen: () => void, onSettings: () => void): Tray {
  // Use a simple default icon — can be replaced with a custom asset later
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');
  let icon: Electron.NativeImage;
  try {
    icon = nativeImage.createFromPath(iconPath);
  } catch {
    // Fallback: create a tiny blue square icon
    icon = nativeImage.createEmpty();
  }

  const tray = new Tray(icon);
  tray.setToolTip('Jarvis — Personal Assistant');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open Jarvis', click: onOpen },
    { label: 'Settings', click: onSettings },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', onOpen);

  return tray;
}
