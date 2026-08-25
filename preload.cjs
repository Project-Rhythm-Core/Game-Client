const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // se irá llenando a medida que traigas los comandos del rust-core
});