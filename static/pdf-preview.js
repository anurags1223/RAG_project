import * as pdfjs from '/vendor/pdfjs/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';
const cache = new Map();
const normalize = text => text.replace(/\s+/g, ' ').trim().toLowerCase();

async function getPDF(url) {
  if (!cache.has(url)) {
    const task = pdfjs.getDocument({url, standardFontDataUrl:'/vendor/pdfjs/standard_fonts/', cMapUrl:'/vendor/pdfjs/cmaps/', cMapPacked:true, wasmUrl:'/vendor/pdfjs/wasm/', iccUrl:'/vendor/pdfjs/iccs/', isEvalSupported:false});
    const pending = task.promise.catch(error => { cache.delete(url); throw error; });
    cache.set(url,pending);
    if (cache.size>3) {
      const key = cache.keys().next().value;
      cache.get(key).then(doc => doc.destroy()).catch(() => {});
      cache.delete(key);
    }
  }
  return cache.get(url);
}

export async function renderPDF(container, url, pageNumber, zoom, excerpt) {
  container.textContent = 'Loading page…';
  try {
    const doc = await getPDF(url);
    if (!container.isConnected) return;
    const page = await doc.getPage(Math.min(pageNumber,doc.numPages));
    const width = Math.max(200,container.clientWidth - 16);
    const original = page.getViewport({scale:1});
    const viewport = page.getViewport({scale:width/original.width*zoom/100});
    const ratio = Math.min(window.devicePixelRatio || 1,2);
    const paper = document.createElement('div'); paper.className = 'pdf-paper';
    paper.style.width = viewport.width + 'px'; paper.style.height = viewport.height + 'px';
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-label',`PDF page ${pageNumber}`);
    canvas.width = Math.floor(viewport.width*ratio); canvas.height = Math.floor(viewport.height*ratio);
    canvas.style.width = viewport.width + 'px'; canvas.style.height = viewport.height + 'px';
    paper.append(canvas);
    if (!container.isConnected) return;
    container.replaceChildren(paper);
    await page.render({canvasContext:canvas.getContext('2d'),viewport,transform:[ratio,0,0,ratio,0,0],background:'white'}).promise;
    if (!container.isConnected || !excerpt) return;
    const text = await page.getTextContent(); const passage = normalize(excerpt);
    const highlights = document.createElement('div'); highlights.className = 'pdf-highlights';
    for (const item of text.items) {
      const value = normalize(item.str || '');
      if (value.length<4 || !passage.includes(value)) continue;
      const tx = pdfjs.Util.transform(viewport.transform,item.transform);
      const height = Math.hypot(tx[2],tx[3]);
      const mark = document.createElement('span');
      Object.assign(mark.style,{left:tx[4]+'px',top:(tx[5]-height*.85)+'px',width:item.width*viewport.scale+'px',height:height*1.1+'px'});
      highlights.append(mark);
    }
    paper.append(highlights);
  } catch (error) {
    if (!container.isConnected) return;
    container.textContent = 'Unable to render this page. Use “Open document” below to view the PDF.';
    console.warn('PDF preview:',error.message);
  }
}
