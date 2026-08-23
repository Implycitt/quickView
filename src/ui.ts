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

export function toggleSidebar(forceState?: 'open' | 'closed') {
    if (!DOM.sidebar) return;
    if (forceState === 'open') {
        DOM.sidebar.classList.replace('w-0', 'w-64');
    } else if (forceState === 'closed') {
        DOM.sidebar.classList.replace('w-64', 'w-0');
    } else {
        DOM.sidebar.classList.replace(
            DOM.sidebar.classList.contains('w-64') ? 'w-64' : 'w-0',
            DOM.sidebar.classList.contains('w-64') ? 'w-0' : 'w-64'
        );
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
        }
    });
}