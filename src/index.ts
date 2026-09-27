import './ui/main.css';
import {
    DOM,
    initDOM,
    toggleSidebar,
    isSidebarOpen,
    getSavedSidebarWidth,
    setSavedSidebarWidth,
    initSidebarResizer,
    toggleKeybindsModal,
    setSidebarTab,
    setSidebarFollowLabel,
} from './ui.js';
import {
    renderAllMainPages,
    renderThumbnails,
    goToPage,
    refreshSidebarSync,
    whenMainRenderIdle,
    setSidebarFollowSuppressed,
    toggleSidebarFollow,
    applyPdfViewerSettings,
    getPdfLocation,
    isSnapSuspended,
    setPdfZoom,
    PdfState,
} from './rendering/pdfRenderer.js';
import { renderFileContent, setFileViewerState } from './rendering/fileHandler.js';
import type { FileResponse } from './types/types.d.ts';
import { initSearch } from './rendering/pdfSearch.js';
import { initKeybinds } from './ui/keybinds.js';
import { initWindowChrome } from './ui/windowChrome.js';
import { prefetchPdfjs } from './pdfjs.js';
import { documentIdentity } from './rendering/documentIdentity.js';
import { getLastDocumentPath, readViewerState, setLastDocumentPath, writeViewerState } from './viewerState.js';
import type { StoredViewerState } from './viewerState.js';

let activeDocumentId: string | null = null;
let activeDocumentType: 'pdf' | 'markdown' | null = null;
let activeViewerState: StoredViewerState | null = null;
let activeDocumentReady = false;
let documentLoadToken = 0;
let stateSaveTimer: ReturnType<typeof setTimeout> | null = null;

function captureViewerState(): StoredViewerState | null {
    if (!activeDocumentId || !activeDocumentType || !activeDocumentReady) return null;
    const location = activeDocumentType === 'pdf' ? getPdfLocation() : null;
    if (activeDocumentType === 'pdf' && !location) return null;

    const state: StoredViewerState = {
        version: 1,
        documentType: activeDocumentType,
        zoomMode: activeDocumentType === 'pdf' ? PdfState.zoomMode : 'auto',
        isSnapMode: PdfState.isSnapMode,
        snapSuspended: isSnapSuspended(),
        sidebarFollow: PdfState.sidebarFollow,
        sidebarOpen: isSidebarOpen(),
        sidebarWidth: getSavedSidebarWidth(),
        sidebarTab: DOM.sidebarSections?.classList.contains('hidden') ? 'previews' : 'sections',
        sidebarScrollTop: DOM.sidebar?.scrollTop ?? 0,
        ...(location ? { location } : {}),
        ...(activeDocumentType === 'markdown' ? { markdownScrollTop: DOM.mainContentNode?.scrollTop ?? 0 } : {}),
    };
    activeViewerState = state;
    writeViewerState(activeDocumentId, state);
    return state;
}

function scheduleViewerStateSave() {
    if (!activeDocumentId || !activeDocumentReady) return;
    if (stateSaveTimer) clearTimeout(stateSaveTimer);
    stateSaveTimer = setTimeout(() => {
        stateSaveTimer = null;
        captureViewerState();
    }, 100);
}

function restoreCommonViewerSettings(state: StoredViewerState | null, restoreSidebarScroll = true) {
    if (!state) return;
    setSavedSidebarWidth(state.sidebarWidth);
    setSidebarTab(state.sidebarTab);
    if (!state.sidebarOpen && isSidebarOpen()) toggleSidebar('closed');
    else if (state.sidebarOpen && !isSidebarOpen()) toggleSidebar('open');
    if (restoreSidebarScroll && DOM.sidebar) DOM.sidebar.scrollTop = state.sidebarScrollTop;
}

function restoreMarkdownViewerState(state: StoredViewerState) {
    restoreCommonViewerSettings(state);
    DOM.mainContentNode.scrollTop = state.markdownScrollTop ?? 0;
}

function attachViewerStateListeners() {
    DOM.mainContentNode?.addEventListener('scroll', scheduleViewerStateSave, { capture: true, passive: true });
    DOM.sidebar?.addEventListener('scroll', scheduleViewerStateSave, { passive: true });
    window.addEventListener('beforeunload', captureViewerState);
    window.addEventListener('pagehide', captureViewerState);
    window.addEventListener('resize', scheduleViewerStateSave);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') captureViewerState();
    });
    window.addEventListener('qv:sidebar-toggled', scheduleViewerStateSave);
    window.addEventListener('qv:sidebar-tab-changed', scheduleViewerStateSave);
    window.addEventListener('qv:sidebar-width-changed', scheduleViewerStateSave);
    window.addEventListener('qv:sidebar-resized', scheduleViewerStateSave);
    window.addEventListener('qv:pdf-layout-rendered', scheduleViewerStateSave);
    window.addEventListener('qv:pdf-viewer-settings-changed', scheduleViewerStateSave);
    DOM.zoomLevelSpan?.addEventListener('change', scheduleViewerStateSave);
    DOM.toggleScrollModeBtn?.addEventListener('click', scheduleViewerStateSave);
    DOM.sidebarFollowBtn?.addEventListener('click', scheduleViewerStateSave);
}

document.addEventListener('DOMContentLoaded', async () => {
    initDOM();
    initSidebarResizer();
    attachViewerStateListeners();
    initKeybinds();
    initSearch();
    initWindowChrome();

    const openDocument = async (content: FileResponse) => {
        const type = content.name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'markdown';
        const documentId = documentIdentity(content.path, content.name, type);
        const sameDocument = activeDocumentId === documentId;
        const token = ++documentLoadToken;
        if (sameDocument && type === 'pdf' && activeDocumentReady) await whenMainRenderIdle();
        if (token !== documentLoadToken) return;

        const outgoingState = activeDocumentReady ? (captureViewerState() ?? activeViewerState) : activeViewerState;
        if (stateSaveTimer) clearTimeout(stateSaveTimer);
        stateSaveTimer = null;

        activeDocumentId = documentId;
        activeDocumentType = type;
        activeDocumentReady = false;
        setLastDocumentPath(content.path);
        const storedState = readViewerState(documentId);
        const viewerState = sameDocument ? (outgoingState ?? storedState) : storedState;
        activeViewerState = viewerState;
        setFileViewerState(documentId, viewerState);
        if (type === 'pdf' && viewerState?.documentType === 'pdf') {
            restoreCommonViewerSettings(viewerState, false);
        } else if (type === 'pdf' && !sameDocument) {
            PdfState.isSnapMode = true;
            PdfState.sidebarFollow = true;
            applyPdfViewerSettings({ isSnapMode: true, snapSuspended: false, sidebarFollow: true });
            setPdfZoom(1, 'auto');
            toggleSidebar('open');
            setSidebarTab('previews');
            DOM.sidebar.scrollTop = 0;
        }
        await renderFileContent(content);
        if (token !== documentLoadToken || !activeDocumentId || !activeDocumentType) return;

        if (type === 'pdf' && viewerState?.documentType === 'pdf') {
            restoreCommonViewerSettings(viewerState);
        } else if (type === 'pdf') {
            applyPdfViewerSettings({ isSnapMode: true, snapSuspended: false, sidebarFollow: true });
        } else if (viewerState?.documentType === 'markdown') {
            restoreMarkdownViewerState(viewerState);
        } else if (!sameDocument) {
            toggleSidebar('closed');
            DOM.sidebar.scrollTop = 0;
        }

        activeDocumentReady = true;
        scheduleViewerStateSave();
    };

    if (DOM.closeKeybindsBtn) DOM.closeKeybindsBtn.addEventListener('click', () => toggleKeybindsModal());
    if (DOM.keybindsToggleBtn) DOM.keybindsToggleBtn.addEventListener('click', () => toggleKeybindsModal());
    window.addEventListener('click', (event) => {
        if (event.target === DOM.keybindsModal) toggleKeybindsModal();
    });

    DOM.sidebarToggle?.addEventListener('click', () => toggleSidebar());
    DOM.tabPreviewsBtn?.addEventListener('click', () => setSidebarTab('previews'));
    DOM.tabSectionsBtn?.addEventListener('click', () => setSidebarTab('sections'));
    DOM.sidebarFollowBtn?.addEventListener('click', () => toggleSidebarFollow());
    setSidebarFollowLabel(PdfState.sidebarFollow);

    window.addEventListener('qv:sidebar-tab-changed', () => refreshSidebarSync(true));
    window.addEventListener('qv:sidebar-toggled', (event) => {
        if ((event as CustomEvent).detail?.opened) {
            setTimeout(() => refreshSidebarSync(true), 350);
            return;
        }
        refreshSidebarSync();
    });

    DOM.toggleScrollModeBtn?.addEventListener('click', () => {
        PdfState.isSnapMode = !PdfState.isSnapMode;
        applyPdfViewerSettings({
            isSnapMode: PdfState.isSnapMode,
            snapSuspended: false,
            sidebarFollow: PdfState.sidebarFollow,
        });
        scheduleViewerStateSave();
    });

    DOM.zoomInBtn?.addEventListener('click', () => {
        PdfState.zoomMode = 'manual';
        PdfState.currentScale = Math.min(9.99, Math.round((PdfState.currentScale + 0.2) * 100) / 100);
        if (DOM.zoomLevelSpan) DOM.zoomLevelSpan.value = `${Math.round(PdfState.currentScale * 100)}%`;
        void renderAllMainPages().then(scheduleViewerStateSave);
        scheduleViewerStateSave();
    });

    DOM.zoomOutBtn?.addEventListener('click', () => {
        if (PdfState.currentScale <= 0.4) return;
        PdfState.zoomMode = 'manual';
        PdfState.currentScale = Math.max(0.1, Math.round((PdfState.currentScale - 0.2) * 100) / 100);
        if (DOM.zoomLevelSpan) DOM.zoomLevelSpan.value = `${Math.round(PdfState.currentScale * 100)}%`;
        void renderAllMainPages().then(scheduleViewerStateSave);
        scheduleViewerStateSave();
    });

    DOM.pageCounter?.addEventListener('change', () => {
        if (!PdfState.currentPdfDoc) {
            DOM.pageCounter.value = '1';
            return;
        }
        const parsed = parseInt(DOM.pageCounter.value, 10);
        goToPage(Number.isNaN(parsed) ? 1 : parsed);
    });
    DOM.pageCounter?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            (event.target as HTMLInputElement).blur();
        } else if (event.key === 'Escape') {
            const input = event.target as HTMLInputElement;
            input.value = input.dataset.current || '1';
            input.blur();
        }
    });

    DOM.zoomLevelSpan?.addEventListener('change', (event) => {
        const input = event.target as HTMLInputElement;
        const zoom = parseFloat(input.value.replace('%', ''));
        if (!Number.isNaN(zoom) && zoom > 10 && zoom < 1000) {
            PdfState.zoomMode = 'manual';
            PdfState.currentScale = zoom / 100;
            void renderAllMainPages().then(scheduleViewerStateSave);
            scheduleViewerStateSave();
        } else {
            input.value = `${Math.round(PdfState.currentScale * 100)}%`;
        }
    });

    document.querySelector<HTMLButtonElement>('.file-picker-btn')?.addEventListener('click', async () => {
        try {
            const content = await window.electronAPI.pickAndReadFile();
            if (content) await openDocument(content);
        } catch (error) {
            console.error('Failed to read file', error);
            DOM.mainContentNode.innerHTML = '<p class="text-red-500 font-medium m-8">Error reading file.</p>';
        }
    });

    window.electronAPI.onFileUpdated((content) => {
        void openDocument(content).catch((error) => console.error('Failed to reload document:', error));
    });
    window.electronAPI.onFileUnavailable((path) => {
        if (getLastDocumentPath() === path) setLastDocumentPath(null);
        console.warn(`Could not restore missing QuickView document: ${path}`);
    });

    const launchPath = await window.electronAPI.getLaunchPath();
    const documentPath = launchPath || getLastDocumentPath();
    if (documentPath) {
        try {
            const content = await window.electronAPI.readFile(documentPath);
            await openDocument(content);
        } catch (error) {
            console.warn('Could not open the QuickView document:', error);
            setLastDocumentPath(null);
        }
    }

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    window.addEventListener('resize', () => {
        if (!PdfState.currentPdfDoc) return;
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(async () => {
            resizeTimer = null;
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
        });
    });

    const warmPdfjs = () => prefetchPdfjs();
    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(warmPdfjs, { timeout: 3000 });
    } else {
        setTimeout(warmPdfjs, 1200);
    }

    let sidebarDragTimer: ReturnType<typeof setTimeout> | null = null;
    window.addEventListener('qv:sidebar-resized', () => {
        if (!PdfState.currentPdfDoc) return;
        if (sidebarDragTimer) clearTimeout(sidebarDragTimer);
        sidebarDragTimer = setTimeout(() => {
            sidebarDragTimer = null;
            setSidebarFollowSuppressed(true);
            void whenMainRenderIdle().then(() => {
                refreshSidebarSync();
                renderThumbnails();
                setSidebarFollowSuppressed(false);
            });
        }, 250);
    });
});
