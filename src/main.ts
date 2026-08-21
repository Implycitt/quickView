import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let currentWatcher: fsSync.FSWatcher | null = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true, 
            nodeIntegration: false
        }
    });

    mainWindow.loadFile('public/index.html');
}

app.whenReady().then(() => {
    ipcMain.handle('file:pick-and-read', async () => {
        const result = await dialog.showOpenDialog({
            properties: ['openFile'],
            filters: [
                { name: 'Accepted Files', extensions: ['pdf', 'md'] }
            ]
        });

        if (result.canceled || result.filePaths.length === 0) {
            return null;
        }

        const filePath = result.filePaths[0];
        const fileName = path.basename(filePath);

        if (currentWatcher) {
            currentWatcher.close();
        }

        try {
            const fileBuffer = await fs.readFile(filePath);
            let debounceTimer: NodeJS.Timeout;
            currentWatcher = fsSync.watch(filePath, (eventType) => {
                if (eventType === 'change') {
                    clearTimeout(debounceTimer);
                    debounceTimer = setTimeout(async () => {
                        try {
                            const updatedBuffer = await fs.readFile(filePath);
                            if (mainWindow) {
                                mainWindow.webContents.send('file:updated', {
                                    path: filePath,
                                    name: fileName,
                                    binary: updatedBuffer,
                                    text: updatedBuffer.toString('utf-8')
                                });
                            }
                        } catch (err) {
                            console.error('Error reading watched file:', err);
                        }
                    }, 50); 
                }
            });
            
            return {
                path: filePath,
                name: fileName,
                binary: fileBuffer,
                text: fileBuffer.toString('utf-8')
            };
        } catch (error) {
            console.error(`Failed to read file at ${filePath}:`, error);
            throw error; 
        }
    });

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});