export const DOM = {} as {
    sidebar: HTMLElement;
    sidebarContent: HTMLElement;
    sidebarToggle: HTMLButtonElement;
    mainContentNode: HTMLElement;
    pdfTools: HTMLElement;
    toggleScrollModeBtn: HTMLButtonElement;
    zoomInBtn: HTMLButtonElement;
    zoomOutBtn: HTMLButtonElement;
    zoomLevelSpan: HTMLInputElement;
};

export function initDOM() {
    DOM.sidebar = document.getElementById('sidebar') as HTMLElement;
    DOM.sidebarContent = document.getElementById('sidebar-content') as HTMLElement;
    DOM.sidebarToggle = document.getElementById('sidebar-toggle') as HTMLButtonElement;
    DOM.mainContentNode = document.getElementById('main-content') as HTMLElement;
    DOM.pdfTools = document.getElementById('pdf-tools') as HTMLElement;
    DOM.toggleScrollModeBtn = document.getElementById('toggle-scroll-mode') as HTMLButtonElement;
    DOM.zoomInBtn = document.getElementById('zoom-in') as HTMLButtonElement;
    DOM.zoomOutBtn = document.getElementById('zoom-out') as HTMLButtonElement;
    DOM.zoomLevelSpan = document.getElementById('zoom-level') as HTMLInputElement;
}

let savedSidebarWidth = '280px';
export function toggleSidebar(forceState?: 'open' | 'closed') {
    if (!DOM.sidebar) return;
    
    const isClosed = DOM.sidebar.style.width === '0px';
    
    if (forceState === 'open' || (!forceState && isClosed)) {
        DOM.sidebar.style.width = savedSidebarWidth;
    } else {
        if (!isClosed) {
            savedSidebarWidth = DOM.sidebar.style.width || '280px';
        }
        DOM.sidebar.style.width = '0px';
    }
}

export function updateScrollModeClasses(isSnapMode: boolean) {
    const scrollContainer = document.getElementById('pdf-scroll-container');
    if (!scrollContainer || !DOM.toggleScrollModeBtn) return;
    
    DOM.toggleScrollModeBtn.innerText = `Mode: ${isSnapMode ? 'Snap' : 'Free'}`;
    
    if (isSnapMode) {
        scrollContainer.classList.add('snap-y', 'snap-mandatory');
        document.querySelectorAll('.pdf-page-wrapper').forEach(w => w.classList.add('snap-center', 'min-h-[90%]'));
    } else {
        scrollContainer.classList.remove('snap-y', 'snap-mandatory');
        document.querySelectorAll('.pdf-page-wrapper').forEach(w => w.classList.remove('snap-center', 'min-h-[90%]'));
    }
}

export function initSidebarResizer() {
    const sidebar = document.getElementById('sidebar');
    const resizer = document.getElementById('sidebar-resizer');

    if (!sidebar || !resizer) return;

    let isResizing = false;

    resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        sidebar.classList.remove('transition-[width]', 'duration-300');
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        
        const newWidth = e.clientX;
        
        if (newWidth > 150 && newWidth < 600) {
            sidebar.style.width = `${newWidth}px`;
        }
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            sidebar.classList.add('transition-[width]', 'duration-300');
            window.dispatchEvent(new Event('resize'));
        }
    });
}