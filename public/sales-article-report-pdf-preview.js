(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else {root.GrabenplanerArticleReportPdfPreview=api;root.GpPdfPreview=api;}
})(typeof window==='object'?window:globalThis,function(){
  'use strict';
  const BASE='/vendor/pdfjs-v6.2.108/';
  let modulePromise;
  async function engine(){
    if(!modulePromise)modulePromise=import(BASE+'build/pdf.min.mjs').then(module=>{
      module.GlobalWorkerOptions.workerSrc=BASE+'build/pdf.worker.min.mjs';return module;
    }).catch(error=>{modulePromise=null;throw error;});
    return modulePromise;
  }
  function mount(host,{ready=()=>{},error=()=>{}}={}){
    const doc=host.ownerDocument,win=doc.defaultView;
    host.classList.add('article-report-pdf-viewer');
    host.innerHTML='<div class="article-report-pdf-viewer-tools"><button type="button" data-preview-prev aria-label="Vorherige PDF-Seite" disabled>←</button><span data-preview-page>Keine Vorschau</span><button type="button" data-preview-next aria-label="Nächste PDF-Seite" disabled>→</button><label>Zoom<select data-preview-zoom><option value="page">Ganze Seite</option><option value="width">Seitenbreite</option><option value="1">100 %</option><option value="1.5">150 %</option></select></label></div><div class="article-report-pdf-canvas-scroll" data-preview-surface tabindex="0" aria-label="Gerenderte PDF-Seite"></div>';
    const q=selector=>host.querySelector(selector),surface=q('[data-preview-surface]');
    let generation=0,renderSerial=0,loading=null,pdf=null,renderTask=null,pageNumber=1,timer=null,dead=false;
    const handlers=[],on=(node,type,fn)=>{node.addEventListener(type,fn);handlers.push(()=>node.removeEventListener(type,fn));};
    function pager(){
      q('[data-preview-page]').textContent=pdf?`Seite ${pageNumber} / ${pdf.numPages}`:'Keine Vorschau';
      q('[data-preview-prev]').disabled=!pdf||pageNumber===1;
      q('[data-preview-next]').disabled=!pdf||pageNumber===pdf.numPages;
    }
    function clear(){
      generation++;renderSerial++;clearTimeout(timer);timer=null;renderTask?.cancel();renderTask=null;
      const previous=loading;loading=null;pdf=null;pageNumber=1;
      if(previous)Promise.resolve(previous.destroy()).catch(()=>{});
      surface.replaceChildren();pager();
    }
    async function render(){
      if(dead||!pdf)return;
      const source=pdf,token=generation,ticket=++renderSerial;
      renderTask?.cancel();renderTask=null;
      try{
        const page=await source.getPage(pageNumber);
        if(dead||token!==generation||ticket!==renderSerial)return;
        const base=page.getViewport({scale:1}),width=Math.max(80,surface.clientWidth-28),height=Math.max(120,surface.clientHeight-28);
        const choice=q('[data-preview-zoom]').value;
        const scale=choice==='page'?Math.min(width/base.width,height/base.height):choice==='width'?width/base.width:Number(choice);
        const ratio=Math.min(2,win.devicePixelRatio||1),viewport=page.getViewport({scale:scale*ratio});
        const canvas=doc.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
        canvas.style.width=Math.ceil(viewport.width/ratio)+'px';canvas.style.height=Math.ceil(viewport.height/ratio)+'px';
        canvas.setAttribute('role','img');canvas.setAttribute('aria-label',`PDF-Seite ${pageNumber} von ${source.numPages}`);
        const task=page.render({canvasContext:canvas.getContext('2d'),viewport});renderTask=task;
        await task.promise;
        if(dead||token!==generation||ticket!==renderSerial)return;
        renderTask=null;surface.replaceChildren(canvas);pager();ready({pages:source.numPages,page:pageNumber});
      }catch(reason){
        if(!dead&&token===generation&&ticket===renderSerial&&reason.name!=='RenderingCancelledException')error(reason);
      }
    }
    async function load(bytes){
      clear();if(dead)return;const token=generation;
      try{
        const module=await engine();if(dead||token!==generation)return;
        const task=module.getDocument({data:new Uint8Array(bytes),cMapUrl:BASE+'cmaps/',cMapPacked:true,standardFontDataUrl:BASE+'standard_fonts/',wasmUrl:BASE+'wasm/',iccUrl:BASE+'iccs/',isEvalSupported:false});loading=task;
        const document=await task.promise;
        if(dead||token!==generation){await task.destroy();return;}
        // Retain the loading task: PDF.js 6 disposes its worker through this
        // owner even after the document has finished loading.
        pdf=document;pager();await render();
      }catch(reason){if(!dead&&token===generation)error(reason);}
    }
    on(q('[data-preview-prev]'),'click',()=>{if(pdf&&pageNumber>1){pageNumber--;void render();}});
    on(q('[data-preview-next]'),'click',()=>{if(pdf&&pageNumber<pdf.numPages){pageNumber++;void render();}});
    on(q('[data-preview-zoom]'),'change',()=>void render());
    const observer=new win.ResizeObserver(()=>{clearTimeout(timer);timer=win.setTimeout(()=>void render(),120);});observer.observe(surface);
    return {load,clear,destroy(){dead=true;clear();observer.disconnect();handlers.forEach(remove=>remove());host.replaceChildren();}};
  }
  return {mount};
});
