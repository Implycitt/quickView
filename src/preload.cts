const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    pickAndReadFile: () => ipcRenderer.invoke('file:pick-and-read'),
    
    onFileUpdated: (callback: (data: any) => void) => 
        ipcRenderer.on('file-updated', (_event: any, data: any) => callback(data))
});