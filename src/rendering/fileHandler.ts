import { DOM, toggleSidebar } from '../ui.js';
import type { FileResponse } from '../types/types.d.ts';

import { renderMarkdownWithCallouts } from './mdRenderer.js';
import { PdfState, renderAllMainPages, renderThumbnails } from './pdfRenderer.js';

export async function renderFileContent(content: FileResponse) {
    const fileName = content.name.toLowerCase();
    
    if (fileName.endsWith('.md')) {
        if (DOM.pdfTools) DOM.pdfTools.classList.add('hidden'); 
        
        const htmlContent = renderMarkdownWithCallouts(content.content || ''); 
        toggleSidebar('closed'); 
        DOM.sidebarContent.innerHTML = ''; 

        DOM.mainContentNode.className = "flex-1 overflow-y-auto flex justify-center bg-gray-900 p-8 transition-colors duration-300"; 
        DOM.mainContentNode.innerHTML = `
            <div class="w-full max-w-4xl mx-auto">
                <div class="bg-gray-800 p-8 md:p-12 rounded-xl shadow-lg border border-gray-700">
                    <article class="prose prose-slate prose-invert prose-a:text-lavender-400 max-w-none">
                        ${htmlContent}
                    </article>
                </div>
            </div>
        `;
        
    } else if (fileName.endsWith('.pdf')) {
        if (DOM.pdfTools) DOM.pdfTools.classList.remove('hidden');
        
        try {
            const uint8Array = new Uint8Array(content.data); 
            const loadingTask = window.pdfjsLib.getDocument({ data: uint8Array }); 
            PdfState.currentPdfDoc = await loadingTask.promise; 
            
            PdfState.zoomMode = 'auto';

            await renderAllMainPages(); 
            await renderThumbnails(); 
            
        } catch (error) {
            console.error("Error rendering PDF:", error);
            DOM.mainContentNode.innerHTML = `<div class="p-8 text-red-500 flex justify-center">Failed to load PDF document.</div>`; 
        }
    } 
}