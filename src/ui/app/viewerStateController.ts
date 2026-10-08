import { DOM, getSavedSidebarWidth, setSavedSidebarWidth, setSidebarTab, toggleSidebar } from '../core/dom.js';
import { PdfState } from '../../rendering/pdf/state.js';
import { getPdfLocation, isSnapSuspended } from '../../rendering/pdf/renderer.js';
import { writeViewerState } from '../../viewer/state.js';
import type { StoredViewerState } from '../../viewer/state.js';

export interface ActiveViewerDocument {
    id: string;
    type: 'pdf' | 'markdown';
    ready: boolean;
    state: StoredViewerState | null;
}

export function captureViewerState(active: ActiveViewerDocument): StoredViewerState | null {
    if (!active.ready) return null;
    const location = active.type === 'pdf' ? getPdfLocation() : null;
    if (active.type === 'pdf' && !location) return active.state;

    const state: StoredViewerState = {
        version: 1,
        documentType: active.type,
        zoomMode: active.type === 'pdf' ? PdfState.zoomMode : 'auto',
        isSnapMode: PdfState.isSnapMode,
        snapSuspended: isSnapSuspended(),
        sidebarFollow: PdfState.sidebarFollow,
        sidebarOpen: !!DOM.sidebar && DOM.sidebar.style.width !== '0px',
        sidebarWidth: getSavedSidebarWidth(),
        sidebarTab: DOM.sidebarSections?.classList.contains('hidden') ? 'previews' : 'sections',
        sidebarScrollTop: DOM.sidebar?.scrollTop ?? 0,
        ...(location ? { location } : {}),
        ...(active.type === 'markdown' ? { markdownScrollTop: DOM.mainContentNode?.scrollTop ?? 0 } : {}),
    };
    writeViewerState(active.id, state);
    return state;
}

export function restoreCommonViewerSettings(state: StoredViewerState | null, restoreSidebarScroll = true) {
    if (!state) return;
    setSavedSidebarWidth(state.sidebarWidth);
    setSidebarTab(state.sidebarTab);
    const sidebarIsOpen = !!DOM.sidebar && DOM.sidebar.style.width !== '0px';
    if (!state.sidebarOpen && sidebarIsOpen) toggleSidebar('closed');
    else if (state.sidebarOpen && !sidebarIsOpen) toggleSidebar('open');
    if (restoreSidebarScroll && DOM.sidebar) DOM.sidebar.scrollTop = state.sidebarScrollTop;
}

export function restoreMarkdownViewerState(state: StoredViewerState) {
    restoreCommonViewerSettings(state);
    DOM.mainContentNode.scrollTop = state.markdownScrollTop ?? 0;
}

export function attachViewerStateListeners(scheduleSave: () => void, capture: () => StoredViewerState | null) {
    DOM.mainContentNode?.addEventListener('scroll', scheduleSave, { capture: true, passive: true });
    DOM.sidebar?.addEventListener('scroll', scheduleSave, { passive: true });
    window.addEventListener('beforeunload', capture);
    window.addEventListener('pagehide', capture);
    window.addEventListener('resize', scheduleSave);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') capture();
    });
    for (const eventName of [
        'qv:sidebar-toggled',
        'qv:sidebar-tab-changed',
        'qv:sidebar-width-changed',
        'qv:sidebar-resized',
        'qv:pdf-layout-rendered',
        'qv:pdf-viewer-settings-changed',
    ]) {
        window.addEventListener(eventName, scheduleSave);
    }
    DOM.zoomLevelSpan?.addEventListener('change', scheduleSave);
    DOM.toggleScrollModeBtn?.addEventListener('click', scheduleSave);
    DOM.sidebarFollowBtn?.addEventListener('click', scheduleSave);
}
