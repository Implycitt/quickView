import { DOM } from '../../../ui/core/dom.js';
import type { PdfLocation } from '../../../viewer/state.js';
import type { PdfDocumentLike, PdfPageLike } from '../types.js';
import type { PdfPageLayout } from '../layout.js';
import type { createPdfNavigation } from '../navigation.js';
import type { createPdfOutline } from '../outline/controller.js';
import type { MainPageRenderer } from './renderQueue.js';
import type { createPdfMeasurement } from './measurement.js';
import type { PdfViewport } from './viewport.js';

interface PdfMainSessionDependencies {
    getDocument: () => PdfDocumentLike | null;
    getScale: () => number;
    setScale: (scale: number) => void;
    isAutoZoom: () => boolean;
    getSavedPosition: () => PdfLocation | null;
    setSavedPosition: (location: PdfLocation | null) => void;
    getPendingRestore: () => PdfLocation | null;
    setPendingRestore: (location: PdfLocation | null) => void;
    getLastKnownPage: () => number;
    layout: PdfPageLayout;
    navigation: ReturnType<typeof createPdfNavigation>;
    outline: ReturnType<typeof createPdfOutline>;
    mainPages: MainPageRenderer;
    measurement: ReturnType<typeof createPdfMeasurement>;
    viewport: PdfViewport;
}

export function createPdfMainSession(deps: PdfMainSessionDependencies) {
    let viewerVersion = 0;
    let mainRenderInFlight: Promise<void> | null = null;
    let finishMeasurementTimer: ReturnType<typeof setTimeout> | null = null;

    function resetViewer() {
        viewerVersion++;
        if (finishMeasurementTimer) {
            clearTimeout(finishMeasurementTimer);
            finishMeasurementTimer = null;
        }
        deps.mainPages.cancel();
        deps.mainPages.clear();
        const scroll = deps.layout.getScrollContainer();
        scroll?.removeEventListener('scroll', deps.viewport.onMainScroll);
        scroll?.remove();
        deps.layout.clearViewer();
        deps.outline.invalidateLayout();
        deps.viewport.clearSettleTimer();
    }

    async function runRenderAllMainPages() {
        const restore = deps.getPendingRestore() ?? deps.getSavedPosition();
        const version = ++viewerVersion;
        if (finishMeasurementTimer) {
            clearTimeout(finishMeasurementTimer);
            finishMeasurementTimer = null;
        }
        deps.mainPages.cancel();
        deps.mainPages.clear();
        deps.viewport.clearSettleTimer();

        const scroll = document.createElement('div');
        scroll.id = 'pdf-scroll-container';
        scroll.className =
            'w-full h-full overflow-y-auto flex flex-col items-center py-8 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] scrollbar-none';
        const doc = deps.getDocument();
        const content = DOM.mainContentNode;
        if (!doc || !content) return;
        const total = doc.numPages;
        try {
            const firstPage = await doc.getPage(1);
            if (version !== viewerVersion) return;
            if (deps.isAutoZoom()) deps.setScale(getFitToScreenScale(firstPage, content));
            const viewport = firstPage.getViewport({ scale: 1 });
            deps.layout.setPlaceholderPoints({ width: viewport.width, height: viewport.height });
            deps.layout.setPagePoints(1, { width: viewport.width, height: viewport.height });
        } catch (error) {
            console.error('Error measuring first page:', error);
        }
        if (version !== viewerVersion) return;
        if (DOM.zoomLevelSpan) DOM.zoomLevelSpan.value = `${Math.round(deps.getScale() * 100)}%`;
        if (DOM.pageCounter) {
            DOM.pageCounter.value = String(deps.getLastKnownPage());
            DOM.pageCounter.dataset.current = String(deps.getLastKnownPage());
        }
        if (DOM.pageTotal) DOM.pageTotal.textContent = `/ ${total}`;

        const topSpacer = document.createElement('div');
        topSpacer.className = 'w-full shrink-0';
        const bottomSpacer = document.createElement('div');
        bottomSpacer.className = 'w-full shrink-0';
        scroll.append(topSpacer, bottomSpacer);
        const old = deps.layout.getScrollContainer();
        deps.layout.setViewer(scroll, total, topSpacer, bottomSpacer);
        old?.removeEventListener('scroll', deps.viewport.onMainScroll);
        old?.remove();
        content.innerHTML = '';
        content.appendChild(scroll);
        scroll.addEventListener('scroll', deps.viewport.onMainScroll, { passive: true });

        deps.layout.sampleLayout();
        deps.layout.mountAroundPage(restore?.page ?? deps.getLastKnownPage() ?? 1);
        deps.layout.updateSpacers();
        deps.navigation.restoreScrollPosition(restore);
        deps.viewport.scheduleMainWindowRender();
        deps.layout.applySnapClasses();
        if (deps.navigation.isSnapSuspended()) scroll.classList.remove('snap-y', 'snap-mandatory');

        const finishMeasurement = () => {
            if (version !== viewerVersion) return;
            const restoreAfterMeasure = deps.getPendingRestore() ?? restore;
            if (restoreAfterMeasure) deps.navigation.restoreScrollPosition(restoreAfterMeasure);
            if (restoreAfterMeasure) {
                deps.setPendingRestore(null);
                deps.setSavedPosition(deps.viewport.captureScrollPos() ?? deps.getSavedPosition());
            }
            window.dispatchEvent(new Event('qv:pdf-layout-rendered'));
            deps.viewport.scheduleMainWindowRender();
        };
        finishMeasurementTimer = setTimeout(() => {
            finishMeasurementTimer = null;
            if (version !== viewerVersion) return;
            void deps.measurement.measureAllPages(version).then(finishMeasurement, (error: unknown) => {
                if (version === viewerVersion) console.error('Error measuring PDF pages:', error);
                finishMeasurement();
            });
        }, 0);
    }

    function renderAllMainPages(): Promise<void> {
        if (!deps.getDocument() || !DOM.mainContentNode) return Promise.resolve();
        const run = runRenderAllMainPages();
        const trackedRun = run.finally(() => {
            if (mainRenderInFlight === trackedRun) mainRenderInFlight = null;
        });
        mainRenderInFlight = trackedRun;
        return trackedRun;
    }

    function getFitToScreenScale(page: PdfPageLike, container: HTMLElement): number {
        const viewport = page.getViewport({ scale: 1 });
        const padding = 64;
        return Math.max(
            0.1,
            Math.min(
                (container.clientWidth - padding) / viewport.width,
                (container.clientHeight - padding) / viewport.height,
            ),
        );
    }

    return {
        getViewerVersion: () => viewerVersion,
        renderAllMainPages,
        resetViewer,
        whenMainRenderIdle: () => mainRenderInFlight ?? Promise.resolve(),
    };
}
