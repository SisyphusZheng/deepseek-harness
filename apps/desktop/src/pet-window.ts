/** Transparent WhaleGirlBot pet window inside the desktop shell (Phase B). */
import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'node:path'

export function createPetWindow(options: { resources: string; onOpenMain: () => void }): BrowserWindow {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const pet = new BrowserWindow({
    width: 220, height: 280, x: width - 260, y: height - 340,
    frame: false, transparent: true, resizable: false, alwaysOnTop: true,
    skipTaskbar: true, hasShadow: false, title: 'WhaleGirlBot',
    webPreferences: {
      preload: join(options.resources, 'pet-preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  })
  ipcMain.removeAllListeners('pet:open-main')
  ipcMain.on('pet:open-main', () => options.onOpenMain())
  let dragOrigin: { x: number; y: number; wx: number; wy: number } | null = null
  ipcMain.removeAllListeners('pet:drag-start')
  ipcMain.removeAllListeners('pet:drag-move')
  ipcMain.removeAllListeners('pet:drag-end')
  ipcMain.on('pet:drag-start', (_event, point: { x: number; y: number }) => {
    const bounds = pet.getBounds()
    dragOrigin = { x: point.x, y: point.y, wx: bounds.x, wy: bounds.y }
  })
  ipcMain.on('pet:drag-move', (_event, point: { x: number; y: number }) => {
    if (!dragOrigin) return
    pet.setPosition(Math.round(dragOrigin.wx + point.x - dragOrigin.x), Math.round(dragOrigin.wy + point.y - dragOrigin.y))
  })
  ipcMain.on('pet:drag-end', () => { dragOrigin = null })
  void pet.loadFile(join(options.resources, 'pet.html'))
  return pet
}
