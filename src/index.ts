import '../main.css';
import { DOM, initDOM, toggleSidebar, updateScrollModeClasses } from './ui.js';
import { renderFileContent, renderAllMainPages, PdfState } from './renderer.js';

document.addEventListener('DOMContentLoaded', () => {
    initDOM();

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
            PdfState.currentScale += 0.2;
            if (DOM.zoomLevelSpan) {
                DOM.zoomLevelSpan.innerText = `${Math.round(PdfState.currentScale * 100)}%`;
            }
            renderAllMainPages();
        });
    }

    if (DOM.zoomOutBtn) {
        DOM.zoomOutBtn.addEventListener('click', () => {
            if (PdfState.currentScale > 0.4) {
                PdfState.currentScale -= 0.2;
                if (DOM.zoomLevelSpan) {
                    DOM.zoomLevelSpan.innerText = `${Math.round(PdfState.currentScale * 100)}%`;
                }
                renderAllMainPages();
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

    window.electronAPI.onFileUpdated(async (content) => {
        await renderFileContent(content);
    });
});