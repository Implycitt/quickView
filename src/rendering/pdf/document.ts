import { DOM } from '../../ui/core/dom.js';
import { loadPdfjs } from './pdfjs.js';
import type { PdfDocumentLike, PdfJsLoadingTask } from './types.js';
import { PdfState } from './state.js';
import {
    renderAllMainPages,
    renderThumbnails,
    renderOutline,
    resetPdfState,
    setCurrentFileName,
    setPdfZoom,
    applyPdfViewerSettings,
    restorePdfPosition,
} from './renderer.js';
import { startBackgroundIndex } from '../search/pdf/backgroundIndexer.js';
import type { FileResponse } from '../../types/types.d.ts';
import type { StoredViewerState } from '../../viewer/state.js';

let activeLoad: PdfJsLoadingTask | null = null;

function setPdfLayout() {
    DOM.mainContentNode.classList.remove('pt-8', 'px-8', 'pb-20');
}

export async function renderPdfDocument(
    content: FileResponse,
    viewerState: StoredViewerState | null,
    reopening: boolean,
    isStale: () => boolean,
): Promise<boolean> {
    if (isStale()) return false;
    if (!content.data) {
        resetPdfState();
        DOM.mainContentNode.innerHTML =
            '<div class="p-8 text-red-500 flex justify-center">Failed to load PDF document.</div>';
        return false;
    }
    setPdfLayout();
    const superseded = activeLoad;
    activeLoad = null;
    if (superseded) void superseded.destroy().catch(() => {});
    resetPdfState(reopening);
    DOM.pdfTools?.classList.remove('hidden');
    DOM.sidebarTabs?.classList.remove('hidden');

    let loadingTask: PdfJsLoadingTask | null = null;
    let openedDoc: PdfDocumentLike | null = null;
    const abandonIfStale = () => {
        if (!isStale()) return false;
        const doc = openedDoc;
        openedDoc = null;
        if (doc && PdfState.currentPdfDoc === doc) {
            PdfState.currentPdfDoc = null;
            void doc.destroy().catch(() => {});
        }
        return true;
    };

    try {
        const pdfjsLib = await loadPdfjs();
        if (isStale()) return false;
        loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(content.data) });
        activeLoad = loadingTask;
        const doc = await loadingTask.promise;
        if (isStale()) {
            if (activeLoad === loadingTask) activeLoad = null;
            void loadingTask.destroy().catch(() => {});
            return false;
        }

        PdfState.currentPdfDoc = doc;
        openedDoc = doc;
        activeLoad = null;
        loadingTask = null;
        setCurrentFileName(content.name);

        const pdfState = viewerState?.documentType === 'pdf' ? viewerState : null;
        if (pdfState) {
            setPdfZoom(pdfState.location?.scale ?? 1, pdfState.zoomMode);
            applyPdfViewerSettings({
                isSnapMode: pdfState.isSnapMode,
                snapSuspended: pdfState.snapSuspended,
                sidebarFollow: pdfState.sidebarFollow,
            });
        } else if (!reopening) {
            setPdfZoom(1, 'auto');
            applyPdfViewerSettings({ isSnapMode: true, snapSuspended: false, sidebarFollow: true });
        }

        await renderAllMainPages();
        if (abandonIfStale()) return false;
        if (pdfState?.location) restorePdfPosition(pdfState.location);
        await renderThumbnails();
        if (abandonIfStale()) return false;
        await renderOutline();
        if (abandonIfStale()) return false;
        openedDoc = null;
        startBackgroundIndex();
        return true;
    } catch (error) {
        if (activeLoad === loadingTask) activeLoad = null;
        if (loadingTask) void loadingTask.destroy().catch(() => {});
        if (abandonIfStale()) return false;
        console.error('Error rendering PDF:', error);
        resetPdfState();
        DOM.mainContentNode.innerHTML =
            '<div class="p-8 text-red-500 flex justify-center">Failed to load PDF document.</div>';
        return false;
    }
}
