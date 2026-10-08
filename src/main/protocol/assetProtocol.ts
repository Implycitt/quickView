import { net, protocol } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const IMAGE_EXTENSIONS = new Set(['.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.svg', '.webp']);

export function registerAssetScheme() {
    protocol.registerSchemesAsPrivileged([
        {
            scheme: 'quickview-asset',
            privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
        },
    ]);
}

export function registerAssetProtocol() {
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
}
