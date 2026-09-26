import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
    platform: typeof process === 'undefined' ? 'unknown' : process.platform,
    pickAndReadFile: () => ipcRenderer.invoke('file:pick-and-read'),
    readFile: (path: string) => ipcRenderer.invoke('file:read', path),
    onFileUpdated: (callback: (data: any) => void) =>
        ipcRenderer.on('file-updated', (_event: IpcRendererEvent, data: any) => callback(data)),
    onFileUnavailable: (callback: (path: string) => void) =>
        ipcRenderer.on('file-unavailable', (_event: IpcRendererEvent, path: string) => callback(path)),
    openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    closeWindow: () => ipcRenderer.send('window:close'),
    getWindowState: () => ipcRenderer.invoke('window:get-state'),
    onWindowState: (callback: (state: { maximized: boolean }) => void) =>
        ipcRenderer.on('window:state', (_event: IpcRendererEvent, state: { maximized: boolean }) => callback(state)),
});
