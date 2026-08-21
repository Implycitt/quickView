export {};

export interface FileResponse {
    path: string;
    name: string;
    binary: Uint8Array;
    text: string;
}

declare global {
    interface Window {
        electronAPI: {
            pickAndReadFile: () => Promise<FileResponse | null>;
            onFileUpdated: (callback: (data: FileResponse) => void) => void;
        };
        marked: any;
        pdfjsLib: any;
    }
}

window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

let currentPdfUrl: string | null = null;

const sidebar = document.getElementById('sidebar') as HTMLElement;
const sidebarContent = document.getElementById('sidebar-content') as HTMLElement;
const sidebarToggle = document.getElementById('sidebar-toggle') as HTMLButtonElement;
const mainContentNode = document.getElementById('main-content') as HTMLElement;

function toggleSidebar(forceState?: 'open' | 'closed') {
    if (forceState === 'open') {
        sidebar.classList.replace('w-0', 'w-64');
    } else if (forceState === 'closed') {
        sidebar.classList.replace('w-64', 'w-0');
    } else {
        if (sidebar.classList.contains('w-64')) {
            sidebar.classList.replace('w-64', 'w-0');
        } else {
            sidebar.classList.replace('w-0', 'w-64');
        }
    }
}

sidebarToggle.addEventListener('click', () => toggleSidebar());

async function renderFileContent(content: FileResponse) {
    const fileName = content.name.toLowerCase();
    const isPdf = fileName.endsWith('.pdf');
    const isMd = fileName.endsWith('.md');

    if (currentPdfUrl) {
        URL.revokeObjectURL(currentPdfUrl);
        currentPdfUrl = null;
    }
    
    if (isMd) {
        toggleSidebar('closed');
        sidebarContent.innerHTML = '';
        mainContentNode.className = "flex-1 overflow-y-auto flex justify-center bg-gray-900 p-8 transition-colors duration-300";
        
        const htmlContent = await window.marked.parse(content.text);
        
        mainContentNode.innerHTML = `
            <div class="w-full max-w-4xl mx-auto">
                <div class="bg-gray-800 p-8 md:p-12 rounded-xl shadow-lg border border-gray-700">
                    <article class="prose prose-slate prose-invert prose-a:text-lavender-400 max-w-none">
                        ${htmlContent}
                    </article>
                </div>
            </div>
        `;
    } else if (isPdf) {
        toggleSidebar('open');
        mainContentNode.className = "flex-1 overflow-hidden flex justify-center bg-[#2c2c2c] transition-colors duration-300";
        
        const blob = new Blob([content.binary.buffer as ArrayBuffer], { type: 'application/pdf' });
        currentPdfUrl = URL.createObjectURL(blob);
        
        mainContentNode.innerHTML = `
            <div class="w-full h-full flex items-center justify-center p-4">
                <iframe 
                    src="${currentPdfUrl}#toolbar=0&navpanes=0" 
                    class="w-full h-full max-w-5xl bg-white shadow-2xl rounded-sm"
                ></iframe>
            </div>
        `;

        sidebarContent.innerHTML = `<p class="text-xs text-lavender-400 text-center animate-pulse">Generating previews...</p>`;
        
        try {
            const loadingTask = window.pdfjsLib.getDocument({ data: content.binary });
            const pdf = await loadingTask.promise;
            
            sidebarContent.innerHTML = '';
            
            for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
                const page = await pdf.getPage(pageNum);
                
                const viewport = page.getViewport({ scale: 0.3 });
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');
                
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                canvas.className = "w-full bg-white border-2 border-transparent hover:border-lavender-500 transition-colors rounded shadow-md";
                
                const renderContext = {
                    canvasContext: context,
                    viewport: viewport
                };
                
                await page.render(renderContext).promise;
                
                const wrapper = document.createElement('div');
                wrapper.className = "group cursor-pointer mb-6";
                wrapper.appendChild(canvas);
                
                const label = document.createElement('p');
                label.className = "text-center text-xs text-gray-500 group-hover:text-lavender-400 mt-2 font-medium transition-colors";
                label.innerText = pageNum.toString();
                wrapper.appendChild(label);
                
                sidebarContent.appendChild(wrapper);
            }
        } catch (error) {
            console.error("Error generating thumbnails:", error);
            sidebarContent.innerHTML = `<p class="text-red-400 text-sm text-center">Failed to load previews.</p>`;
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const filePickerBtn = document.querySelector('.file-picker-btn') as HTMLButtonElement;

    filePickerBtn.addEventListener('click', async () => {
        try {
            const content = await window.electronAPI.pickAndReadFile();
            if (!content) return;
            await renderFileContent(content);
        } catch (error) {
            console.error("Failed to read file", error);
            mainContentNode.innerHTML = `<p class="text-red-500 font-medium m-8">Error reading file.</p>`;
        }
    });

    window.electronAPI.onFileUpdated(async (content) => {
        await renderFileContent(content);
    });
});