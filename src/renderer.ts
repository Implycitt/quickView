import '../main.css'

import { DOM, updateScrollModeClasses } from './ui.js';
import type { FileResponse } from './types/types.d.ts';

declare global {
    interface Window {
        pdfjsLib: any;
        marked: any;
    }
}

window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

export const PdfState = {
    currentPdfUrl: null as string | null,
    currentPdfDoc: null as any,
    currentScale: 1.4,
    isSnapMode: true
};

export async function renderAllMainPages() {
    if (!PdfState.currentPdfDoc) return;
    
    let scrollContainer = document.getElementById('pdf-scroll-container');
    if (!scrollContainer) {
        DOM.mainContentNode.innerHTML = `<div id="pdf-scroll-container" class="w-full h-full overflow-y-auto flex flex-col items-center py-8 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] scrollbar-none scroll-smooth"></div>`;
        scrollContainer = document.getElementById('pdf-scroll-container');
    } else {
        scrollContainer.innerHTML = '';
    }

    const outputScale = window.devicePixelRatio || 1;

    for (let pageNum = 1; pageNum <= PdfState.currentPdfDoc.numPages; pageNum++) {
        const page = await PdfState.currentPdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: PdfState.currentScale });
        
        const pageContainer = document.createElement('div');
        pageContainer.id = `page-container-${pageNum}`;
        pageContainer.className = 'pdf-page-container mb-8 shadow-lg bg-white shrink-0 snap-center';
        pageContainer.style.width = `${viewport.width}px`;
        pageContainer.style.height = `${viewport.height}px`;

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        if (!ctx) continue;

        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        
        const transform = outputScale !== 1 
            ? [outputScale, 0, 0, outputScale, 0, 0] 
            : undefined;

        const renderContext = {
            canvasContext: ctx,
            transform: transform,
            viewport: viewport
        };
        
        await page.render(renderContext).promise;
        pageContainer.appendChild(canvas);
        
        if (scrollContainer) {
            scrollContainer.appendChild(pageContainer);
        }
    }
    
    updateScrollModeClasses(PdfState.isSnapMode);
}

async function renderThumbnails() {
    if (!PdfState.currentPdfDoc || !DOM.sidebarContent) return;
    
    DOM.sidebarContent.innerHTML = '';
    const outputScale = window.devicePixelRatio || 1;

    for (let pageNum = 1; pageNum <= PdfState.currentPdfDoc.numPages; pageNum++) {
        const page = await PdfState.currentPdfDoc.getPage(pageNum);
        
        const viewport = page.getViewport({ scale: 1.0 }); 
        
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        if (!ctx) continue;

        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        
        canvas.style.width = '100%';
        canvas.style.height = 'auto';
        
        canvas.className = 'mb-4 cursor-pointer border-2 border-transparent hover:border-lavender-400 transition-colors shadow-sm rounded bg-white';
        
        canvas.onclick = () => {
            const targetPage = document.getElementById(`page-container-${pageNum}`);
            if (targetPage) {
                targetPage.scrollIntoView({ behavior: 'smooth' });
            }
        };
        
        const transform = outputScale !== 1 
            ? [outputScale, 0, 0, outputScale, 0, 0] 
            : undefined;

        await page.render({ 
            canvasContext: ctx, 
            transform: transform, 
            viewport: viewport 
        }).promise;
        
        DOM.sidebarContent.appendChild(canvas);
    }
}

export async function renderFileContent(content: FileResponse) {
    const fileName = content.name.toLowerCase();
    
    if (fileName.endsWith('.md')) {
        if (DOM.pdfTools) {
            DOM.pdfTools.classList.add('hidden');
        }
        
        const htmlContent = window.marked ? window.marked.parse(content.content || '') : content.content;
        DOM.mainContentNode.innerHTML = `<div class="markdown-body p-8 max-w-4xl mx-auto w-full">${htmlContent}</div>`;
        
    } else if (fileName.endsWith('.pdf')) {
        if (DOM.pdfTools) {
            DOM.pdfTools.classList.remove('hidden');
        }
        
        try {
            const uint8Array = new Uint8Array(content.data);
            const loadingTask = window.pdfjsLib.getDocument({ data: uint8Array });
            PdfState.currentPdfDoc = await loadingTask.promise;
            
            PdfState.currentScale = 1.4;
            if (DOM.zoomLevelSpan) {
                DOM.zoomLevelSpan.innerText = `${Math.round(PdfState.currentScale * 100)}%`;
            } 

            await renderAllMainPages();
            await renderThumbnails();
            
        } catch (error) {
            console.error("Error rendering PDF:", error);
            DOM.mainContentNode.innerHTML = `<div class="p-8 text-red-500 flex justify-center">Failed to load PDF document.</div>`;
        }
    } 
}