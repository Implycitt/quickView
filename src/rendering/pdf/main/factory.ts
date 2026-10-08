import { getSidebarTargetWidth } from '../../../ui/core/dom.js';
import { PdfState } from '../state.js';
import type { PdfLocation } from '../../../viewer/state.js';
import { createPdfPageLayout } from '../layout.js';
import { createPdfNavigation } from '../navigation.js';
import { createPdfOutline } from '../outline/controller.js';
import { createThumbnailRenderer } from '../thumbnails/renderer.js';
import { clearPageSpans, renderPageTextLayer } from '../../search/pdf/textLayer.js';
import { createMainPageRenderer } from './renderQueue.js';
import { createPdfMeasurement } from './measurement.js';
import { createPdfViewport } from './viewport.js';
import { createPdfMainSession } from './session.js';

const MAX_OUTPUT_SCALE = 2;
const RENDER_CONCURRENCY = 3;

export interface PdfViewerState {
    savedScrollPos: PdfLocation | null;
    pendingRestoreLocation: PdfLocation | null;
    lastKnownPage: number;
}

type PdfLayout = ReturnType<typeof createPdfPageLayout>;
type PdfNavigation = ReturnType<typeof createPdfNavigation>;
type PdfOutline = ReturnType<typeof createPdfOutline>;
type PdfThumbnails = ReturnType<typeof createThumbnailRenderer>;
type PdfMainPages = ReturnType<typeof createMainPageRenderer>;
type PdfMeasurement = ReturnType<typeof createPdfMeasurement>;
type PdfViewport = ReturnType<typeof createPdfViewport>;
type PdfSession = ReturnType<typeof createPdfMainSession>;

interface PdfViewerServices {
    layout: PdfLayout;
    navigation: PdfNavigation;
    outline: PdfOutline;
    thumbnails: PdfThumbnails;
    mainPages: PdfMainPages;
    measurement: PdfMeasurement;
    viewport: PdfViewport;
    session: PdfSession;
}

export function createPdfViewerServices(state: PdfViewerState): PdfViewerServices {
    const services = {} as PdfViewerServices;

    services.layout = createPdfPageLayout({
        getScale: () => PdfState.currentScale,
        getSnapMode: () => PdfState.isSnapMode,
        isSnapSuspended: () => services.navigation.isSnapSuspended(),
        onPageSizeChanged: () => services.viewport.scheduleMainWindowRender(),
        onPageUnmounted: (page) => services.mainPages.onPageUnmounted(page),
    });

    services.navigation = createPdfNavigation({
        getScrollContainer: services.layout.getScrollContainer,
        getPageCount: services.layout.getPageCount,
        getPageTop: services.layout.getPageTop,
        getPageHeight: services.layout.getPageHeight,
        isPageMeasured: services.layout.isPageMeasured,
        mountAroundPage: services.layout.mountAroundPage,
        ensureGeometry: services.layout.sampleLayout,
        currentPageAtViewport: () => {
            state.lastKnownPage = services.layout.currentPageAtViewport(state.lastKnownPage);
            return state.lastKnownPage;
        },
        scheduleRender: () => services.viewport.scheduleMainWindowRender(),
        measurePage: (page) => services.measurement.measurePageNow(page),
        waitForMeasurement: () => services.measurement.whenMeasurementDone(),
        refreshSidebar: (scrollToActive) => services.viewport.refreshSidebarSync(scrollToActive),
        applySnapClasses: services.layout.applySnapClasses,
        clearPendingRestore: () => (state.pendingRestoreLocation = null),
    });

    services.outline = createPdfOutline({
        getDocument: () => PdfState.currentPdfDoc,
        getScale: () => PdfState.currentScale,
        getCurrentPosition: () => services.viewport.currentViewPosition(),
        getCurrentPage: () => state.lastKnownPage,
        hasScrollContainer: () => !!services.layout.getScrollContainer(),
        getSidebarFollow: () => PdfState.sidebarFollow,
        isFollowSuppressed: services.navigation.isFollowSuppressed,
        getPageHeightPoints: services.layout.getPageHeightPoints,
        jumpToPage: services.navigation.jumpToPage,
    });

    services.thumbnails = createThumbnailRenderer({
        getDocument: () => PdfState.currentPdfDoc,
        getPagePointSize: services.layout.getPagePointSize,
        getSidebarTargetWidth,
        getSidebarFollow: () => PdfState.sidebarFollow,
        isFollowSuppressed: services.navigation.isFollowSuppressed,
        getCurrentPage: () => state.lastKnownPage,
        jumpToPage: services.navigation.jumpToPage,
        getOutputScale,
        renderConcurrency: RENDER_CONCURRENCY,
        getMainRenderActivity: () => services.mainPages.getActivity(),
        notifyMainQueue: () => services.mainPages.pump(),
        releasePage: (page) => services.mainPages.releasePage(page),
        isObsoleteRender,
    });

    services.mainPages = createMainPageRenderer({
        getDocument: () => PdfState.currentPdfDoc,
        getScale: () => PdfState.currentScale,
        layout: services.layout,
        getOutputScale,
        renderConcurrency: RENDER_CONCURRENCY,
        getActiveThumbnailRenders: () => services.thumbnails.getActivity().activeRenders,
        renderTextLayer: renderPageTextLayer,
        clearPageSpans,
        resolveDestination: services.outline.resolveDestination,
        isObsoleteRender,
        onRenderSettled: () => services.thumbnails.schedule(),
    });

    services.measurement = createPdfMeasurement({
        getDocument: () => PdfState.currentPdfDoc,
        layout: services.layout,
        getViewerVersion: () => services.session.getViewerVersion(),
        scheduleThumbnails: () => services.thumbnails.schedule(),
    });

    services.viewport = createPdfViewport({
        layout: services.layout,
        navigation: services.navigation,
        thumbnails: services.thumbnails,
        outline: services.outline,
        mainPages: services.mainPages,
        getDocument: () => PdfState.currentPdfDoc,
        getSavedPosition: () => state.savedScrollPos,
        setSavedPosition: (location) => (state.savedScrollPos = location),
        getPendingRestore: () => state.pendingRestoreLocation,
        setPendingRestore: (location) => (state.pendingRestoreLocation = location),
        getLastKnownPage: () => state.lastKnownPage,
    });

    services.session = createPdfMainSession({
        getDocument: () => PdfState.currentPdfDoc,
        getScale: () => PdfState.currentScale,
        setScale: (scale) => (PdfState.currentScale = scale),
        isAutoZoom: () => PdfState.zoomMode === 'auto',
        getSavedPosition: () => state.savedScrollPos,
        setSavedPosition: (location) => (state.savedScrollPos = location),
        getPendingRestore: () => state.pendingRestoreLocation,
        setPendingRestore: (location) => (state.pendingRestoreLocation = location),
        getLastKnownPage: () => state.lastKnownPage,
        layout: services.layout,
        navigation: services.navigation,
        outline: services.outline,
        mainPages: services.mainPages,
        measurement: services.measurement,
        viewport: services.viewport,
    });

    return services;
}

function getOutputScale(): number {
    return Math.min(window.devicePixelRatio || 1, MAX_OUTPUT_SCALE);
}

function isObsoleteRender(error: unknown, doc: unknown): boolean {
    return (
        (error as { name?: string } | null)?.name === 'RenderingCancelledException' || PdfState.currentPdfDoc !== doc
    );
}
