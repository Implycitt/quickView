process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

import { app, BrowserWindow, ipcMain, dialog, Menu, shell, protocol, net } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

protocol.registerSchemesAsPrivileged([
    { scheme: 'quickview-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

type ActiveWatcher = {
    sender: Electron.WebContents;
    listener: (curr: fs.Stats, prev: fs.Stats) => void;
    debounceTimer: ReturnType<typeof setTimeout> | null;
    revision: number;
    latestStats: fs.Stats | null;
};

let activeWatchedPath: string | null = null;
let activeWatcher: ActiveWatcher | null = null;
const IMAGE_EXTENSIONS = new Set(['.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.svg', '.webp']);
let launchPathDelivered = false;
const useCustomTitleBar = process.platform === 'linux';

const isPackaged = app.isPackaged;
const args = process.argv.slice(isPackaged ? 1 : 2);
let cliFilePath: string | null = null;

if (args.length > 0 && !args[0].startsWith('--')) {
    cliFilePath = args[0];
}

async function getFilePayload(targetPath: string) {
    const fileName = path.basename(targetPath);
    if (fileName.toLowerCase().endsWith('.md')) {
        const content = await fs.promises.readFile(targetPath, 'utf-8');
        return { name: fileName, path: targetPath, content };
    } else {
        const fileBuffer = await fs.promises.readFile(targetPath);
        return { name: fileName, path: targetPath, data: fileBuffer };
    }
}

function sameFileVersion(left: fs.Stats, right: fs.Stats): boolean {
    return (
        left.mtimeMs === right.mtimeMs &&
        left.ctimeMs === right.ctimeMs &&
        left.size === right.size &&
        left.ino === right.ino &&
        left.dev === right.dev
    );
}

function isDevServerNavigation(targetUrl: string): boolean {
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    if (!devServerUrl) return false;

    try {
        return new URL(targetUrl).origin === new URL(devServerUrl).origin;
    } catch {
        return false;
    }
}

function setupFileWatcher(targetPath: string, webContents: Electron.WebContents) {
    if (activeWatchedPath && activeWatcher) {
        fs.unwatchFile(activeWatchedPath, activeWatcher.listener);
        if (activeWatcher.debounceTimer) clearTimeout(activeWatcher.debounceTimer);
    }

    activeWatchedPath = targetPath;
    const watcher: ActiveWatcher = {
        sender: webContents,
        listener: () => {},
        debounceTimer: null,
        revision: 0,
        latestStats: null,
    };

    const scheduleReload = () => {
        if (watcher.debounceTimer) clearTimeout(watcher.debounceTimer);
        const revision = watcher.revision;
        watcher.debounceTimer = setTimeout(async () => {
            watcher.debounceTimer = null;
            if (activeWatcher !== watcher || revision !== watcher.revision || watcher.sender.isDestroyed()) return;

            try {
                const beforeRead = await fs.promises.stat(targetPath);
                if (activeWatcher !== watcher || revision !== watcher.revision || watcher.sender.isDestroyed()) return;
                if (watcher.latestStats && !sameFileVersion(beforeRead, watcher.latestStats)) {
                    watcher.latestStats = beforeRead;
                    watcher.revision++;
                    scheduleReload();
                    return;
                }

                const payload = await getFilePayload(targetPath);
                const afterRead = await fs.promises.stat(targetPath);
                if (!sameFileVersion(beforeRead, afterRead)) {
                    watcher.latestStats = afterRead;
                    watcher.revision++;
                    scheduleReload();
                    return;
                }
                if (activeWatcher !== watcher || revision !== watcher.revision || watcher.sender.isDestroyed()) return;
                watcher.sender.send('file-updated', payload);
            } catch (err) {
                if (activeWatcher === watcher && revision === watcher.revision) {
                    console.error('[Main] Error re-reading file on update:', err);
                }
            }
        }, 200);
    };

    watcher.listener = (curr: fs.Stats, prev: fs.Stats) => {
        if (sameFileVersion(curr, prev) || watcher.sender.isDestroyed()) return;

        watcher.latestStats = curr;
        watcher.revision++;
        scheduleReload();
    };

    activeWatcher = watcher;
    fs.watchFile(targetPath, { interval: 100 }, watcher.listener);
}

ipcMain.handle('file:get-launch-path', () => {
    if (launchPathDelivered) return null;
    launchPathDelivered = true;
    return cliFilePath ? path.resolve(cliFilePath) : null;
});

ipcMain.handle('file:read', async (event, targetPath: string) => {
    if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) {
        throw new Error('A valid absolute file path is required.');
    }
    const fileName = path.basename(targetPath).toLowerCase();
    if (!['.md', '.pdf'].some((extension) => fileName.endsWith(extension))) {
        throw new Error('QuickView only opens Markdown and PDF documents.');
    }
    await fs.promises.access(targetPath, fs.constants.R_OK);
    const payload = await getFilePayload(targetPath);
    setupFileWatcher(targetPath, event.sender);
    return payload;
});

ipcMain.handle('file:pick-and-read', async (event) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Documents', extensions: ['md', 'pdf'] }],
    });

    if (canceled || filePaths.length === 0) return null;

    const filePath = filePaths[0];

    setupFileWatcher(filePath, event.sender);
    return await getFilePayload(filePath);
});

ipcMain.on('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
});

ipcMain.on('window:toggle-maximize', (event) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    if (!target) return;
    if (target.isMaximized()) {
        target.unmaximize();
    } else {
        target.maximize();
    }
});

ipcMain.on('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.handle('window:get-state', (event) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    return { maximized: target?.isMaximized() ?? false };
});

ipcMain.handle('shell:open-external', async (_event, rawUrl: string) => {
    if (typeof rawUrl !== 'string') return;
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return;
    }
    if (['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
        await shell.openExternal(rawUrl);
    }
});

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        autoHideMenuBar: true,
        frame: !useCustomTitleBar,
        backgroundColor: '#101828',
        webPreferences: {
            preload: path.join(__dirname, '../dist-electron/preload.mjs'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        icon: path.join(__dirname, useCustomTitleBar ? '../assets/icons/icon.png' : '../assets/icons/icon.ico'),
    });

    const sendWindowState = () => {
        if (win.isDestroyed()) return;
        win.webContents.send('window:state', { maximized: win.isMaximized() });
    };

    win.on('maximize', sendWindowState);
    win.on('unmaximize', sendWindowState);
    win.on('enter-full-screen', sendWindowState);
    win.on('leave-full-screen', sendWindowState);

    win.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http:') || url.startsWith('https:')) {
            shell.openExternal(url);
        }
        return { action: 'deny' };
    });

    win.webContents.on('will-navigate', (event, url) => {
        if (isDevServerNavigation(url)) return;

        event.preventDefault();
        if (url.startsWith('http:') || url.startsWith('https:')) {
            shell.openExternal(url);
        }
    });

    if (process.env.VITE_DEV_SERVER_URL) {
        win.loadURL(process.env.VITE_DEV_SERVER_URL + 'src/ui/index.html');
    } else {
        win.loadFile(path.join(__dirname, '../dist/src/ui/index.html'));
    }
}

app.whenReady().then(() => {
    protocol.handle('quickview-asset', async (request) => {
        try {
            const requestUrl = new URL(request.url);
            if (requestUrl.hostname !== 'media' || requestUrl.pathname !== '/') {
                return new Response('Not found', { status: 404 });
            }

            const requestedPath = requestUrl.searchParams.get('path');
            if (!requestedPath || !path.isAbsolute(requestedPath)) {
                return new Response('Invalid media path', { status: 400 });
            }
            if (!IMAGE_EXTENSIONS.has(path.extname(requestedPath).toLowerCase())) {
                return new Response('Unsupported media type', { status: 415 });
            }

            const resolvedPath = await fs.promises.realpath(requestedPath);
            const stats = await fs.promises.stat(resolvedPath);
            if (!stats.isFile()) return new Response('Media not found', { status: 404 });
            await fs.promises.access(resolvedPath, fs.constants.R_OK);
            return await net.fetch(pathToFileURL(resolvedPath).href);
        } catch {
            return new Response('Media not found', { status: 404 });
        }
    });

    Menu.setApplicationMenu(null);
    if (useCustomTitleBar && app.isPackaged) {
        app.setDesktopName('quickview.desktop');
    }
    createWindow();
});
