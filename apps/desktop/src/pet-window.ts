/** Transparent WhaleGirl Bot pet window inside the desktop shell (Phase B). */
import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'node:path'

export function createPetWindow(options: { resources: string; onOpenMain: () => void }): BrowserWindow {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const pet = new BrowserWindow({
    width: 220, height: 280, x: width - 260, y: height - 340,
    frame: false, transparent: true, resizable: false, alwaysOnTop: true,
    skipTaskbar: true, hasShadow: false, title: 'WhaleGirl Bot',
    webPreferences: {
      preload: join(options.resources, 'pet-preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  })
  ipcMain.removeAllListeners('pet:open-main')
  ipcMain.on('pet:open-main', () => options.onOpenMain())
  void pet.loadFile(join(options.resources, 'pet.html'))
  return pet
}
