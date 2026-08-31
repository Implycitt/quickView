import { DOM, toggleSidebar, toggleKeybindsModal } from '../ui.js';

export function initKeybinds() {
    document.addEventListener('keydown', (e) => {
        if (['INPUT', 'TEXTAREA'].includes((document.activeElement as HTMLElement)?.tagName)) {
            return;
        }

        var keyPressed = e.key.toLowerCase();

        // Show keybinds
        if (keyPressed === '/') {
            e.preventDefault();
            toggleKeybindsModal();
        }

        // change mode
        if (keyPressed === 'm') {
            e.preventDefault();
            DOM.toggleScrollModeBtn?.click();
        }

        // sidebar
        if (keyPressed === 's') {
            e.preventDefault();
            toggleSidebar();
        }
        
        // zoom in
        if (keyPressed === 'z') {
            e.preventDefault();
            DOM.zoomInBtn?.click(); 
        }
        
        // zoom out
        if (keyPressed === 'x') {
            e.preventDefault();
            DOM.zoomOutBtn?.click(); 
        }

        // pick file
        if (keyPressed === 'f') {
            e.preventDefault();
            const filePickerBtn = document.querySelector('.file-picker-btn') as HTMLButtonElement;
            filePickerBtn?.click();
        }
        
        // scroll up
        if (keyPressed === 'j') {
            e.preventDefault();
            performScroll(1);
        }
        
        // scroll down
        if (keyPressed === 'k') {
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