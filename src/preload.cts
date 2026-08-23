import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
    pickAndReadFile: () => ipcRenderer.invoke('file:pick-and-read'),
    onFileUpdated: (callback: (data: any) => void) => 
        ipcRenderer.on('file-updated', (_event: IpcRendererEvent, data: any) => callback(data))
});