import fs from 'node:fs';
import path from 'node:path';
import type { FileResponse } from '../../types/types.d.ts';

export async function readFilePayload(targetPath: string): Promise<FileResponse> {
    const fileName = path.basename(targetPath);
    if (fileName.toLowerCase().endsWith('.md')) {
        const content = await fs.promises.readFile(targetPath, 'utf-8');
        return { name: fileName, path: targetPath, content };
    }

    const data = await fs.promises.readFile(targetPath);
    return { name: fileName, path: targetPath, data };
}

export async function validateDocumentPath(targetPath: unknown): Promise<string> {
    if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) {
        throw new Error('A valid absolute file path is required.');
    }

    const fileName = path.basename(targetPath).toLowerCase();
    if (!['.md', '.pdf'].some((extension) => fileName.endsWith(extension))) {
        throw new Error('QuickView only opens Markdown and PDF documents.');
    }

    await fs.promises.access(targetPath, fs.constants.R_OK);
    return targetPath;
}
