import { DOM, toggleSidebar } from '../ui.js';

export function initKeybinds() {
    document.addEventListener('keydown', (e) => {
        if (['INPUT', 'TEXTAREA'].includes((document.activeElement as HTMLElement)?.tagName)) {
            return;
        }

        // change mode
        if (e.key.toLowerCase() === 'm') {
            e.preventDefault();
            DOM.toggleScrollModeBtn?.click();
        }

        // sidebar
        if (e.key.toLowerCase() === 's') {
            e.preventDefault();
            toggleSidebar();
        }
        
        // zoom in
        if (e.key.toLowerCase() === 'z') {
            e.preventDefault();
            DOM.zoomInBtn?.click(); 
        }
        
        // zoom out
        if (e.key.toLowerCase() === 'x') {
            e.preventDefault();
            DOM.zoomOutBtn?.click(); 
        }

        // pick file
        if (e.key.toLowerCase() === 'f') {
            e.preventDefault();
            const filePickerBtn = document.querySelector('.file-picker-btn') as HTMLButtonElement;
            filePickerBtn?.click();
        }
        
        // scroll up
        if (e.key.toLowerCase() === 'j') {
            e.preventDefault();
            performScroll(1);
        }
        
        // scroll down
        if (e.key.toLowerCase() === 'k') {
            e.preventDefault();
            performScroll(-1);
        }
    });
}

function performScroll(direction: number) {
    const pdfContainer = document.getElementById('pdf-scroll-container');
    const container = pdfContainer || DOM.mainContentNode;

    if (!container) return;

    const isSnapMode = container.classList.contains('snap-mandatory');
    const amount = isSnapMode ? (container.clientHeight * 0.8) : 120;

    container.scrollBy({ 
        top: amount * direction, 
        behavior: 'smooth' 
    });
}