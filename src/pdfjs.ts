const PDFJS_VERSION = '4.10.38';
const CDN_BASE = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;

const MODULE_URL = `${CDN_BASE}/pdf.min.mjs`;
const WORKER_URL = `${CDN_BASE}/pdf.worker.min.mjs`;

let loading: Promise<any> | null = null;

export function loadPdfjs(): Promise<any> {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (!loading) {
        loading = import(/* @vite-ignore */ MODULE_URL)
            .then((pdfjsLib: any) => {
                pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_URL;
                window.pdfjsLib = pdfjsLib;
                return pdfjsLib;
            })
            .catch((error) => {
                loading = null;
                throw error;
            });
    }
    return loading;
}
