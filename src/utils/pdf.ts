import * as pdfjsLib from "pdfjs-dist";
// Inline the worker as a blob-backed Worker. Loading the worker from a separate
// `.mjs` asset is unreliable inside the packaged webview (module-worker MIME
// handling differs per platform), so we let Vite bundle it inline instead.
// eslint-disable-next-line import/default
import PdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker&inline";

pdfjsLib.GlobalWorkerOptions.workerPort = new PdfjsWorker();

export { pdfjsLib };
export type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
