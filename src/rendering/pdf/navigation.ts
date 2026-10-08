import { DOM, setSidebarFollowLabel, updateScrollModeClasses } from '../../ui/core/dom.js';
import { PdfState } from './state.js';
import type { PdfLocation } from '../../viewer/state.js';

interface NavigationDependencies {
    getScrollContainer: () => HTMLElement | null;
    getPageCount: () => number;
    getPageTop: (page: number) => number;
    getPageHeight: (page: number) => number;
    isPageMeasured: (page: number) => boolean;
    mountAroundPage: (page: number) => void;
    ensureGeometry: () => void;
    currentPageAtViewport: () => number;
    scheduleRender: () => void;
    measurePage: (page: number) => Promise<void>;
    waitForMeasurement: () => Promise<void>;
    refreshSidebar: (scrollToActive?: boolean) => void;
    applySnapClasses: () => void;
    clearPendingRestore?: () => void;
}

export function createPdfNavigation(deps: NavigationDependencies) {
    let snapSuspended = false;
    let resumeHandler: (() => void) | null = null;
    let followSuppressed = false;

    function clearSnapResumeHandler() {
        if (!resumeHandler) return;
        window.removeEventListener('wheel', resumeHandler, { capture: true });
        window.removeEventListener('keydown', resumeHandler, { capture: true });
        resumeHandler = null;
    }

    function installSnapResumeHandler() {
        const scroll = deps.getScrollContainer();
        if (!scroll || !PdfState.isSnapMode || !snapSuspended || resumeHandler) return;
        const resume = () => {
            clearSnapResumeHandler();
            snapSuspended = false;
            const current = deps.getScrollContainer();
            if (!current || !PdfState.isSnapMode) return;
            current.classList.add('snap-y', 'snap-mandatory');
            deps.applySnapClasses();
            window.dispatchEvent(new Event('qv:pdf-viewer-settings-changed'));
        };
        resumeHandler = resume;
        window.addEventListener('wheel', resume, { capture: true, passive: true });
        window.addEventListener('keydown', resume, { capture: true });
    }

    function suspendSnap() {
        const scroll = deps.getScrollContainer();
        if (!PdfState.isSnapMode || snapSuspended || !scroll || !scroll.classList.contains('snap-mandatory')) return;
        snapSuspended = true;
        scroll.classList.remove('snap-y', 'snap-mandatory');
        installSnapResumeHandler();
        window.dispatchEvent(new Event('qv:pdf-viewer-settings-changed'));
    }

    function applySettings(settings: { isSnapMode: boolean; snapSuspended: boolean; sidebarFollow: boolean }) {
        PdfState.isSnapMode = settings.isSnapMode;
        PdfState.sidebarFollow = settings.sidebarFollow;
        clearSnapResumeHandler();
        snapSuspended = settings.snapSuspended && settings.isSnapMode;
        setSidebarFollowLabel(PdfState.sidebarFollow);
        updateScrollModeClasses(PdfState.isSnapMode);
        const scroll = deps.getScrollContainer();
        if (snapSuspended && scroll) {
            scroll.classList.remove('snap-y', 'snap-mandatory');
            installSnapResumeHandler();
        }
        deps.applySnapClasses();
        window.dispatchEvent(new Event('qv:pdf-viewer-settings-changed'));
    }

    function setZoom(scale: number, mode: 'auto' | 'manual') {
        if (!Number.isFinite(scale) || scale <= 0) return;
        PdfState.currentScale = scale;
        PdfState.zoomMode = mode;
        if (DOM.zoomLevelSpan) DOM.zoomLevelSpan.value = `${Math.round(scale * 100)}%`;
        window.dispatchEvent(new Event('qv:pdf-viewer-settings-changed'));
    }

    function captureLocation(saved: PdfLocation | null): PdfLocation | null {
        const scroll = deps.getScrollContainer();
        if (!scroll || deps.getPageCount() === 0) return saved;
        const scrollTop = scroll.scrollTop;
        const page = deps.currentPageAtViewport();
        const height = deps.getPageHeight(page) || 1;
        const fraction = Math.max(0, Math.min(1, (scrollTop - deps.getPageTop(page)) / height));
        return { page, fraction, scrollTop, scale: PdfState.currentScale };
    }

    function scrollTopForLocation(location: PdfLocation): number {
        const page = Math.min(deps.getPageCount(), Math.max(1, location.page));
        const sameScale = Math.abs(PdfState.currentScale - location.scale) < 0.001;
        const target = sameScale
            ? location.scrollTop
            : deps.getPageTop(page) + location.fraction * deps.getPageHeight(page);
        const scroll = deps.getScrollContainer();
        const maxScroll = Math.max(0, (scroll?.scrollHeight ?? 0) - (scroll?.clientHeight ?? 0));
        return Math.max(0, Math.min(maxScroll, target));
    }

    function restoreScrollPosition(location: PdfLocation | null) {
        const scroll = deps.getScrollContainer();
        if (!location || !scroll || deps.getPageCount() === 0) return;
        deps.mountAroundPage(location.page);
        deps.ensureGeometry();
        scroll.style.scrollBehavior = 'auto';
        scroll.scrollTop = scrollTopForLocation(location);
        scroll.style.removeProperty('scroll-behavior');
    }

    function restorePosition(location: PdfLocation | null) {
        if (!location) return;
        const pageCount = deps.getPageCount();
        const page = Math.max(1, Math.min(pageCount || location.page, location.page));
        const scroll = deps.getScrollContainer();
        if (!scroll || pageCount === 0) return;
        deps.mountAroundPage(page);
        deps.ensureGeometry();
        scroll.style.scrollBehavior = 'auto';
        scroll.scrollTop = scrollTopForLocation(location);
        scroll.style.removeProperty('scroll-behavior');
        if (DOM.pageCounter) {
            DOM.pageCounter.value = String(page);
            DOM.pageCounter.dataset.current = String(page);
        }
        if (!snapSuspended) deps.clearPendingRestore?.();
        deps.scheduleRender();
    }

    function goToPage(pageNumber: number) {
        const scroll = deps.getScrollContainer();
        const pageCount = deps.getPageCount();
        if (!scroll || pageCount === 0 || !PdfState.currentPdfDoc) return;
        const page = Math.min(pageCount, Math.max(1, Math.round(pageNumber)));
        deps.mountAroundPage(page);
        const apply = () => {
            const current = deps.getScrollContainer();
            if (!current) return;
            current.style.scrollBehavior = 'auto';
            current.scrollTop = deps.getPageTop(page);
            current.style.removeProperty('scroll-behavior');
        };
        apply();
        deps.scheduleRender();
        if (deps.isPageMeasured(page)) return;
        void Promise.all([deps.measurePage(page), deps.waitForMeasurement()]).then(() => {
            if (!PdfState.currentPdfDoc || Math.abs(deps.currentPageAtViewport() - page) > 3) return;
            apply();
        });
    }

    function jumpToPage(pageNumber: number, yCss: number | null = null, center = false) {
        const pageCount = deps.getPageCount();
        if (pageCount === 0 || !PdfState.currentPdfDoc) return;
        const page = Math.max(1, Math.min(pageCount, Math.round(pageNumber)));
        deps.mountAroundPage(page);
        deps.scheduleRender();
        const jump = () => {
            const target = document.getElementById(`page-container-${page}`);
            const scroll = deps.getScrollContainer();
            if (!target || !scroll) return;
            const pageRect = target.getBoundingClientRect();
            const pageHeight = pageRect.height || deps.getPageHeight(page);
            const y = yCss == null ? (center ? pageHeight / 2 : 0) : Math.max(0, Math.min(yCss, pageHeight - 1));
            const base = pageRect.top - scroll.getBoundingClientRect().top + scroll.scrollTop;
            const top = center ? Math.max(0, base + y - scroll.clientHeight / 2) : base + y;
            if (yCss !== null && y > 0) suspendSnap();
            const distance = Math.abs(top - scroll.scrollTop);
            if (distance > (scroll.clientHeight || 1) * 1.5) {
                scroll.style.scrollBehavior = 'auto';
                scroll.scrollTop = top;
                scroll.style.removeProperty('scroll-behavior');
            } else {
                scroll.scrollTo({ top, behavior: 'smooth' });
            }
        };
        jump();
        if (deps.isPageMeasured(page)) return;
        void Promise.all([deps.measurePage(page), deps.waitForMeasurement()]).then(() => {
            if (!PdfState.currentPdfDoc || Math.abs(deps.currentPageAtViewport() - page) > 3) return;
            jump();
        });
    }

    function setSidebarFollowSuppressed(value: boolean) {
        followSuppressed = value;
    }

    function toggleSidebarFollow(): boolean {
        PdfState.sidebarFollow = !PdfState.sidebarFollow;
        setSidebarFollowLabel(PdfState.sidebarFollow);
        if (PdfState.sidebarFollow) deps.refreshSidebar(true);
        return PdfState.sidebarFollow;
    }

    function reset() {
        clearSnapResumeHandler();
        snapSuspended = false;
        followSuppressed = false;
    }

    return {
        applySettings,
        captureLocation,
        goToPage,
        isSnapSuspended: () => snapSuspended,
        jumpToPage,
        restorePosition,
        restoreScrollPosition,
        scrollTopForLocation,
        setSidebarFollowSuppressed,
        setZoom,
        toggleSidebarFollow,
        reset,
        isFollowSuppressed: () => followSuppressed,
    };
}
