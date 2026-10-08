import type { PdfJsModule } from './types.js';

const PDFJS_VERSION = '4.10.38';
const CDN_BASE = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;

const MODULE_URL = `${CDN_BASE}/pdf.min.mjs`;
const WORKER_URL = `${CDN_BASE}/pdf.worker.min.mjs`;

let loading: Promise<PdfJsModule> | null = null;

export function loadPdfjs(): Promise<PdfJsModule> {
    if (!loading) {
        loading = import(/* @vite-ignore */ MODULE_URL)
            .then((module: unknown) => {
                const pdfjsLib = module as PdfJsModule;
                pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_URL;
                return pdfjsLib;
            })
            .catch((error) => {
                loading = null;
                throw error;
            });
    }
    return loading;
}
