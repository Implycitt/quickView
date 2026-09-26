import { DOM, toggleSidebar, toggleKeybindsModal, setSidebarTab } from '../ui.js';
import { openSearch } from '../rendering/pdfSearch.js';
import { toggleSidebarFollow } from '../rendering/pdfRenderer.js';

const DEFAULT_FREE_SCROLL_AMOUNT = 240;
const MIN_FREE_SCROLL_AMOUNT = 60;
const MAX_FREE_SCROLL_AMOUNT = 720;
const FREE_SCROLL_AMOUNT_KEY = 'quickview.free-scroll-amount.v1';
const HELD_SCROLL_SPEED = 4200;
const FREE_SCROLL_HOLD_DELAY_MS = 120;
const SNAP_SCROLL_REPEAT_DELAY_MS = 220;
const SNAP_SCROLL_REPEAT_INTERVAL_MS = 220;

let freeScrollAmount = readFreeScrollAmount();
let pendingFreeScroll: {
    key: string;
    direction: number;
    container: HTMLElement;
    timeoutId: number;
} | null = null;
let activeFreeScroll: { key: string; frameId: number } | null = null;
let activeSnapScroll: {
    key: string;
    direction: number;
    container: HTMLElement;
    timeoutId: number | null;
    intervalId: number | null;
} | null = null;

export function initKeybinds() {
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) {
            return;
        }

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
        if (keyPressed === 'j' || keyPressed === 'arrowdown') {
            e.preventDefault();
            handleScrollKeyDown(e, 1);
        }

        // scroll up
        if (keyPressed === 'k' || keyPressed === 'arrowup') {
            e.preventDefault();
            handleScrollKeyDown(e, -1);
        }
    });

    document.addEventListener('keyup', (event) => {
        const key = event.key.toLowerCase();
        stopHeldSnapScroll(key);
        stopHeldFreeScroll(key, true);
    });
    window.addEventListener('blur', () => {
        stopHeldSnapScroll();
        stopHeldFreeScroll();
    });

    initFreeScrollAmountControl();
}

function readFreeScrollAmount(): number {
    try {
        const stored = Number(localStorage.getItem(FREE_SCROLL_AMOUNT_KEY));
        return Number.isFinite(stored) && stored >= MIN_FREE_SCROLL_AMOUNT && stored <= MAX_FREE_SCROLL_AMOUNT
            ? stored
            : DEFAULT_FREE_SCROLL_AMOUNT;
    } catch {
        return DEFAULT_FREE_SCROLL_AMOUNT;
    }
}

function initFreeScrollAmountControl() {
    const slider = document.getElementById('free-scroll-amount') as HTMLInputElement | null;
    if (!slider) return;

    slider.value = String(freeScrollAmount);
    slider.addEventListener('input', () => {
        freeScrollAmount = Math.min(MAX_FREE_SCROLL_AMOUNT, Math.max(MIN_FREE_SCROLL_AMOUNT, Number(slider.value)));
        try {
            localStorage.setItem(FREE_SCROLL_AMOUNT_KEY, String(freeScrollAmount));
        } catch {
            // The setting still applies for this session if storage is unavailable.
        }
    });
}

function handleScrollKeyDown(event: KeyboardEvent, direction: number) {
    const pdfContainer = document.getElementById('pdf-scroll-container');
    const isSnapMode = !!pdfContainer?.classList.contains('snap-mandatory');
    if (!pdfContainer || isSnapMode) {
        if (!event.repeat) {
            stopHeldSnapScroll();
            stopHeldFreeScroll();
            performScroll(direction);
            if (pdfContainer && isSnapMode) {
                startHeldSnapScroll(event.key.toLowerCase(), direction, pdfContainer);
            }
        }
        return;
    }

    if (event.repeat) return;

    stopHeldFreeScroll();
    const key = event.key.toLowerCase();
    const timeoutId = window.setTimeout(() => {
        if (pendingFreeScroll?.key !== key) return;

        pendingFreeScroll = null;
        let lastFrameTime = performance.now();
        const scrollFrame = (frameTime: number) => {
            if (activeFreeScroll?.key !== key) return;
            const container = document.getElementById('pdf-scroll-container');
            if (!container || container !== pdfContainer || container.classList.contains('snap-mandatory')) {
                stopHeldFreeScroll();
                return;
            }

            const elapsed = Math.min(frameTime - lastFrameTime, 50);
            lastFrameTime = frameTime;
            container.scrollTop += (direction * HELD_SCROLL_SPEED * elapsed) / 1000;
            activeFreeScroll.frameId = window.requestAnimationFrame(scrollFrame);
        };

        activeFreeScroll = { key, frameId: window.requestAnimationFrame(scrollFrame) };
    }, FREE_SCROLL_HOLD_DELAY_MS);

    pendingFreeScroll = { key, direction, container: pdfContainer, timeoutId };
}

function startHeldSnapScroll(key: string, direction: number, container: HTMLElement) {
    const repeat = {
        key,
        direction,
        container,
        timeoutId: null as number | null,
        intervalId: null as number | null,
    };
    activeSnapScroll = repeat;
    repeat.timeoutId = window.setTimeout(() => {
        if (activeSnapScroll !== repeat) return;
        repeat.timeoutId = null;
        repeatSnapScroll(repeat);
        if (activeSnapScroll === repeat) {
            repeat.intervalId = window.setInterval(() => repeatSnapScroll(repeat), SNAP_SCROLL_REPEAT_INTERVAL_MS);
        }
    }, SNAP_SCROLL_REPEAT_DELAY_MS);
}

function repeatSnapScroll(repeat: NonNullable<typeof activeSnapScroll>) {
    if (activeSnapScroll !== repeat) return;

    const container = document.getElementById('pdf-scroll-container');
    if (
        !repeat.container.isConnected ||
        container !== repeat.container ||
        !repeat.container.classList.contains('snap-mandatory')
    ) {
        stopHeldSnapScroll(repeat.key);
        return;
    }

    performScroll(repeat.direction);
}

function stopHeldSnapScroll(key?: string) {
    if (!activeSnapScroll || (key && activeSnapScroll.key !== key)) return;

    const repeat = activeSnapScroll;
    activeSnapScroll = null;
    if (repeat.timeoutId !== null) window.clearTimeout(repeat.timeoutId);
    if (repeat.intervalId !== null) window.clearInterval(repeat.intervalId);
}

function stopHeldFreeScroll(key?: string, scrollTap = false) {
    if (pendingFreeScroll && (!key || pendingFreeScroll.key === key)) {
        const pending = pendingFreeScroll;
        window.clearTimeout(pending.timeoutId);
        pendingFreeScroll = null;
        if (
            scrollTap &&
            pending.container.isConnected &&
            document.getElementById('pdf-scroll-container') === pending.container
        ) {
            performScroll(pending.direction);
        }
    }

    if (activeFreeScroll && (!key || activeFreeScroll.key === key)) {
        window.cancelAnimationFrame(activeFreeScroll.frameId);
        activeFreeScroll = null;
    }
}

function performScroll(direction: number) {
    const pdfContainer = document.getElementById('pdf-scroll-container');
    const container = pdfContainer || DOM.mainContentNode;

    if (!container) return;

    const isSnapMode = container.classList.contains('snap-mandatory');
    const amount = isSnapMode ? container.clientHeight * 0.8 : freeScrollAmount;

    container.scrollBy({
        top: amount * direction,
        behavior: 'smooth',
    });
}
