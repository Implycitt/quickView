import { DOM, toggleSidebar, toggleKeybindsModal, setSidebarTab } from '../ui.js';
import { openSearch } from '../rendering/pdfSearch.js';
import { toggleSidebarFollow } from '../rendering/pdfRenderer.js';

export function initKeybinds() {
    document.addEventListener('keydown', (e) => {
        if (['INPUT', 'TEXTAREA'].includes((document.activeElement as HTMLElement)?.tagName)) {
            return;
        }

        const keyPressed = e.key.toLowerCase();

        // Show keybinds
        if (keyPressed === '/') {
            e.preventDefault();
            toggleKeybindsModal();
        }

        // fuzzy search
        if (keyPressed === ';' || keyPressed === ':') {
            e.preventDefault();
            openSearch();
        }

        // close keybinds
        if (keyPressed === 'escape') {
            if (!DOM.keybindsModal?.classList.contains('hidden')) {
                e.preventDefault();
                toggleKeybindsModal();
            }
        }

        // change mode
        if (keyPressed === 'm') {
            e.preventDefault();
            DOM.toggleScrollModeBtn?.click();
        }

        // sidebar - open/close
        if (keyPressed === 's') {
            e.preventDefault();
            toggleSidebar();
        }

        // sections - previews toggle
        if (keyPressed === 'o') {
            const previews = DOM.sidebarPreviews.checkVisibility();
            e.preventDefault();
            if (previews) {
                setSidebarTab('sections');
            } else {
                setSidebarTab('previews');
            }
        }

        // toggle sidebar follow
        if (keyPressed === 'l') {
            e.preventDefault();
            toggleSidebarFollow();
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

        // jump to page
        if (keyPressed === 'g') {
            e.preventDefault();
            DOM.pageCounter?.focus();
            DOM.pageCounter?.select();
        }

        // scroll down
        if (keyPressed === 'j') {
            e.preventDefault();
            performScroll(1);
        }

        // scroll up
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
    const amount = isSnapMode ? container.clientHeight * 0.8 : 120;

    container.scrollBy({
        top: amount * direction,
        behavior: 'smooth',
    });
}
