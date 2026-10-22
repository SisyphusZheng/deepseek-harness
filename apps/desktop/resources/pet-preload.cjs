const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('petBridge', { openMain: () => ipcRenderer.send('pet:open-main') })
