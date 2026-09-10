import './ui/main.css';
import {
    DOM,
    initDOM,
    toggleSidebar,
    updateScrollModeClasses,
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
    PdfState,
} from './rendering/pdfRenderer.js';
import { renderFileContent } from './rendering/fileHandler.js';
import { initSearch } from './rendering/pdfSearch.js';
import { initKeybinds } from './ui/keybinds.js';

document.addEventListener('DOMContentLoaded', () => {
    initDOM();
    initSidebarResizer();
    initKeybinds();
    initSearch();

    if (DOM.closeKeybindsBtn) DOM.closeKeybindsBtn.addEventListener('click', () => toggleKeybindsModal());
    if (DOM.keybindsToggleBtn) DOM.keybindsToggleBtn.addEventListener('click', () => toggleKeybindsModal());

    window.addEventListener('click', (e) => {
        if (e.target === DOM.keybindsModal) {
            toggleKeybindsModal();
        }
    });

    if (DOM.sidebarToggle) {
        DOM.sidebarToggle.addEventListener('click', () => toggleSidebar());
    }

    if (DOM.tabPreviewsBtn) {
        DOM.tabPreviewsBtn.addEventListener('click', () => setSidebarTab('previews'));
    }
    if (DOM.tabSectionsBtn) {
        DOM.tabSectionsBtn.addEventListener('click', () => setSidebarTab('sections'));
    }

    if (DOM.sidebarFollowBtn) {
        DOM.sidebarFollowBtn.addEventListener('click', () => toggleSidebarFollow());
    }
    setSidebarFollowLabel(PdfState.sidebarFollow);

    window.addEventListener('qv:sidebar-tab-changed', () => refreshSidebarSync(true));
    window.addEventListener('qv:sidebar-toggled', (e) => {
        if ((e as CustomEvent).detail?.opened) {
            setTimeout(() => refreshSidebarSync(true), 350);
            return;
        }
        refreshSidebarSync();
    });

    if (DOM.toggleScrollModeBtn) {
        DOM.toggleScrollModeBtn.addEventListener('click', () => {
            PdfState.isSnapMode = !PdfState.isSnapMode;
            updateScrollModeClasses(PdfState.isSnapMode);
        });
    }

    if (DOM.zoomInBtn) {
        DOM.zoomInBtn.addEventListener('click', () => {
            PdfState.zoomMode = 'manual';
            PdfState.currentScale += 0.2;
            if (DOM.zoomLevelSpan) {
                DOM.zoomLevelSpan.value = `${Math.round(PdfState.currentScale * 100)}%`;
            }
            renderAllMainPages();
        });
    }

    if (DOM.zoomOutBtn) {
        DOM.zoomOutBtn.addEventListener('click', () => {
            PdfState.zoomMode = 'manual';
            if (PdfState.currentScale > 0.4) {
                PdfState.currentScale -= 0.2;
                if (DOM.zoomLevelSpan) {
                    DOM.zoomLevelSpan.value = `${Math.round(PdfState.currentScale * 100)}%`;
                }
                renderAllMainPages();
            }
        });
    }

    if (DOM.pageCounter) {
        DOM.pageCounter.addEventListener('change', () => {
            if (!PdfState.currentPdfDoc) {
                DOM.pageCounter.value = '1';
                return;
            }
            const parsed = parseInt(DOM.pageCounter.value, 10);
            const target = isNaN(parsed) ? 1 : parsed;
            goToPage(target);
        });
        DOM.pageCounter.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                (e.target as HTMLInputElement).blur();
            } else if (e.key === 'Escape') {
                const input = e.target as HTMLInputElement;
                input.value = input.dataset.current || '1';
                input.blur();
            }
        });
    }

    const stepPage = (delta: number) => {
        if (!PdfState.currentPdfDoc) return;
        const parsed = parseInt(DOM.pageCounter.value, 10);
        const current = isNaN(parsed) ? 1 : parsed;
        goToPage(current + delta);
    };

    if (DOM.pagePrev) {
        DOM.pagePrev.addEventListener('click', () => stepPage(-1));
    }
    if (DOM.pageNext) {
        DOM.pageNext.addEventListener('click', () => stepPage(1));
    }

    if (DOM.zoomLevelSpan) {
        DOM.zoomLevelSpan.addEventListener('change', (e) => {
            const target = e.target as HTMLInputElement;
            const parsedZoom = parseFloat(target.value.replace('%', ''));

            if (!isNaN(parsedZoom) && parsedZoom > 10 && parsedZoom < 1000) {
                PdfState.zoomMode = 'manual';
                PdfState.currentScale = parsedZoom / 100;
                renderAllMainPages();
            } else {
                target.value = `${Math.round(PdfState.currentScale * 100)}%`;
            }
        });
    }

    const filePickerBtn = document.querySelector('.file-picker-btn') as HTMLButtonElement;
    if (filePickerBtn) {
        filePickerBtn.addEventListener('click', async () => {
            try {
                const content = await window.electronAPI.pickAndReadFile();
                if (content) await renderFileContent(content);
            } catch (error) {
                console.error('Failed to read file', error);
                if (DOM.mainContentNode) {
                    DOM.mainContentNode.innerHTML = `<p class="text-red-500 font-medium m-8">Error reading file.</p>`;
                }
            }
        });
    }

    window.electronAPI.onFileUpdated(async (content: any) => {
        await renderFileContent(content);
    });

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
