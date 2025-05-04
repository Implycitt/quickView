import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString()

var pdfCanvas = document.getElementById("pdfContainer") as HTMLCanvasElement;

const pdfPath = '../../assets/ConfidenceIntervals.pdf';
const pdf = await pdfjsLib.getDocument(pdfPath).promise;

const pdfPage = await pdf.getPage(1);
const viewport = pdfPage.getViewport({ scale: 1.0 });
const context = pdfCanvas.getContext("2d");

pdfCanvas.width = viewport.width;
pdfCanvas.height = viewport.height;

const renderTask = pdfPage.render({
  canvasContext: context,
  viewport,
});

await renderTask.promise;
