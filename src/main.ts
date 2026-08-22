process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let activeWatchedPath: string | null = null;

ipcMain.handle('file:pick-and-read', async (event) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
            { name: 'Documents', extensions: ['md', 'pdf'] }
        ]
    });

    if (canceled || filePaths.length === 0) {
        return null;
    }

    const filePath = filePaths[0];
    const fileName = path.basename(filePath);
    const webContents = event.sender;


    if (activeWatchedPath) {
        fs.unwatchFile(activeWatchedPath);
        activeWatchedPath = null;
    }

    activeWatchedPath = filePath;

    fs.watchFile(filePath, { interval: 300 }, async (curr, prev) => {
        if (curr.mtimeMs !== prev.mtimeMs) {
            try {
                await new Promise(resolve => setTimeout(resolve, 50));

                if (fileName.endsWith('.md')) {
                    const content = await fs.promises.readFile(filePath, 'utf-8');
                    webContents.send('file-updated', { name: fileName, content });
                } else {
                    const fileBuffer = await fs.promises.readFile(filePath);
                    webContents.send('file-updated', { name: fileName, data: Array.from(fileBuffer) });
                }
            } catch (err) {
                console.error("[Main] Error re-reading file on update:", err);
            }
        }
    });

    if (fileName.endsWith('.md')) {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        return { name: fileName, content };
    } else {
        const fileBuffer = await fs.promises.readFile(filePath);
        return { name: fileName, data: Array.from(fileBuffer) };
    }
});

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, '../dist-electron/preload.mjs'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    if (process.env.VITE_DEV_SERVER_URL) {
        win.loadURL(process.env.VITE_DEV_SERVER_URL);
    } else {
        win.loadFile(path.join(__dirname, '../dist/index.html'));
    }
}

app.whenReady().then(createWindow);