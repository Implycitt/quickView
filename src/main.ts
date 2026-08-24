process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

import { app, BrowserWindow, ipcMain, dialog, Menu } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let activeWatchedPath: string | null = null;

const isPackaged = app.isPackaged;
const args = process.argv.slice(isPackaged ? 1 : 2);
let cliFilePath: string | null = null;

if (args.length > 0 && !args[0].startsWith('--')) {
    cliFilePath = args[0];
}

async function getFilePayload(targetPath: string) {
    const fileName = path.basename(targetPath);
    if (fileName.endsWith('.md')) {
        const content = await fs.promises.readFile(targetPath, 'utf-8');
        return { name: fileName, content };
    } else {
        const fileBuffer = await fs.promises.readFile(targetPath);
        return { name: fileName, data: Array.from(fileBuffer) };
    }
}

function setupFileWatcher(targetPath: string, webContents: Electron.WebContents) {
    if (activeWatchedPath) {
        fs.unwatchFile(activeWatchedPath);
    }
    
    activeWatchedPath = targetPath;

    fs.watchFile(targetPath, { interval: 300 }, async (curr, prev) => {
        if (curr.mtimeMs !== prev.mtimeMs) {
            try {
                await new Promise(resolve => setTimeout(resolve, 50));
                const payload = await getFilePayload(targetPath);
                webContents.send('file-updated', payload);
            } catch (err) {
                console.error("[Main] Error re-reading file on update:", err);
            }
        }
    });
}

ipcMain.handle('file:pick-and-read', async (event) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Documents', extensions: ['md', 'pdf'] }]
    });

    if (canceled || filePaths.length === 0) return null;

    const filePath = filePaths[0];
    
    setupFileWatcher(filePath, event.sender);
    return await getFilePayload(filePath);
});

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, '../dist-electron/preload.mjs'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    win.webContents.on('did-finish-load', async () => {
        if (cliFilePath && fs.existsSync(cliFilePath)) {
            try {
                setupFileWatcher(cliFilePath, win.webContents);
                const payload = await getFilePayload(cliFilePath);
                win.webContents.send('file-updated', payload);
            } catch (err) {
                console.error("Failed to load CLI file:", err);
            }
        }
    });

    if (process.env.VITE_DEV_SERVER_URL) {
        win.loadURL(process.env.VITE_DEV_SERVER_URL + 'src/ui/index.html');
    } else {
        win.loadFile(path.join(__dirname, '../dist/src/ui/index.html'));
    }
}

app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    createWindow();
});