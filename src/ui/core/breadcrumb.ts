import { DOM } from './dom.js';

export function setBreadcrumbPath(path: string | null) {
    const element = DOM.breadcrumb;
    if (!element) return;

    if (!path) {
        element.classList.add('hidden');
        if (element.textContent) {
            element.textContent = '';
            element.title = '';
        }
        return;
    }

    if (element.textContent !== path) {
        element.textContent = path;
        element.title = path;
    }
    element.classList.remove('hidden');
}
