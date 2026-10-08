import {
    refreshSidebarSync,
    renderAllMainPages,
    renderThumbnails,
    setSidebarFollowSuppressed,
    whenMainRenderIdle,
} from '../../rendering/pdf/renderer.js';
import { PdfState } from '../../rendering/pdf/state.js';

interface ResizeDependencies {
    scheduleViewerStateSave: () => void;
}

export function installViewerResizeHandlers({ scheduleViewerStateSave }: ResizeDependencies) {
    let windowTimer: ReturnType<typeof setTimeout> | null = null;
    window.addEventListener('resize', () => {
        if (!PdfState.currentPdfDoc) return;
        if (windowTimer) clearTimeout(windowTimer);
        windowTimer = setTimeout(async () => {
            windowTimer = null;
            setSidebarFollowSuppressed(true);
            await renderAllMainPages();
            renderThumbnails();
            setTimeout(() => {
                setSidebarFollowSuppressed(false);
                refreshSidebarSync();
                scheduleViewerStateSave();
            }, 350);
        }, 150);
    });

    const dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    dprQuery.addEventListener('change', () => {
        if (!PdfState.currentPdfDoc) return;
        setSidebarFollowSuppressed(true);
        void renderAllMainPages().then(() => {
            renderThumbnails();
            setSidebarFollowSuppressed(false);
            refreshSidebarSync();
            scheduleViewerStateSave();
        });
    });

    let sidebarTimer: ReturnType<typeof setTimeout> | null = null;
    window.addEventListener('qv:sidebar-resized', () => {
        if (!PdfState.currentPdfDoc) return;
        if (sidebarTimer) clearTimeout(sidebarTimer);
        sidebarTimer = setTimeout(() => {
            sidebarTimer = null;
            setSidebarFollowSuppressed(true);
            void whenMainRenderIdle().then(() => {
                refreshSidebarSync();
                renderThumbnails();
                setSidebarFollowSuppressed(false);
            });
        }, 250);
    });
}
