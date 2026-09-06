import './ui/main.css';
import { DOM, initDOM, toggleSidebar, updateScrollModeClasses, initSidebarResizer, toggleKeybindsModal } from './ui.js';
import { renderAllMainPages, renderThumbnails, goToPage, PdfState } from './rendering/pdfRenderer.js';
import { renderFileContent } from './rendering/fileHandler.js';
import { initKeybinds } from './ui/keybinds.js';

document.addEventListener('DOMContentLoaded', () => {
    initDOM();
    initSidebarResizer(); 
    initKeybinds();

    if (DOM.closeKeybindsBtn || DOM.keybindsToggleBtn) {
        DOM.closeKeybindsBtn.addEventListener('click', () => toggleKeybindsModal());
    }

    window.addEventListener('click', (e) => {
        if (e.target === DOM.keybindsModal) {
            toggleKeybindsModal();
        }
    });

    if (DOM.sidebarToggle) {
        DOM.sidebarToggle.addEventListener('click', () => toggleSidebar());
    }
    
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
                (DOM.zoomLevelSpan as HTMLInputElement).value = `${Math.round(PdfState.currentScale * 100)}%`;
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
                    (DOM.zoomLevelSpan as HTMLInputElement).value = `${Math.round(PdfState.currentScale * 100)}%`;
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

    const zoomInput = DOM.zoomLevelSpan as HTMLInputElement;
    if (zoomInput) {
        zoomInput.addEventListener('change', (e) => {
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
                console.error("Failed to read file", error);
                if (DOM.mainContentNode) {
                    DOM.mainContentNode.innerHTML = `<p class="text-red-500 font-medium m-8">Error reading file.</p>`;
                }
            }
        });
    }

    window.electronAPI.onFileUpdated(async (content: any) => {
        await renderFileContent(content);
    });

    let resizeTimer: any = null;
    window.addEventListener('resize', () => {
        if (!PdfState.currentPdfDoc) return;
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            renderAllMainPages();
            renderThumbnails();
        }, 150);
    });
});