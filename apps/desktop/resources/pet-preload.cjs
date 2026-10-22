const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('petBridge', {
  openMain: () => ipcRenderer.send('pet:open-main'),
  dragStart: (x, y) => ipcRenderer.send('pet:drag-start', { x, y }),
  dragMove: (x, y) => ipcRenderer.send('pet:drag-move', { x, y }),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
})
