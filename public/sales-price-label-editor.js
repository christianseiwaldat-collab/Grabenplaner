(function(host, factory) {
  'use strict';
  const common = typeof module === 'object' && module.exports;
  const api = factory(common ? require('./sales-price-label-design') : host.GrabenplanerPriceLabelDesign,
    common ? require('./sales-price-label-fonts') : host.GrabenplanerPriceLabelFonts);
  if (common) module.exports = api;
  if (host) host.GrabenplanerPriceLabelEditor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(Design, Fonts) {
  'use strict';
  const names = Object.freeze({headline:'Überschrift',brand:'Marke',description:'Bezeichnung',price:'Preis',articleNumber:'Artikelnummer',ean:'EAN',tax:'MwSt.-Hinweis',footer:'Fußtext'});
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function textValues(options, article, price) {
    return {headline:options.headline, brand:article?.brand || '', description:article?.description || 'Artikel auswählen und aktuellen Preis laden',
      price:price === null ? 'Preis prüfen' : price + ' €', articleNumber:'Art. ' + (article?.articleNumber || '-'),
      ean:'EAN ' + (article?.ean || '- nicht hinterlegt'), tax:Design.taxText(article?.taxRate), footer:options.footer};
  }
  function mount({preview, toolbar, images, live, read, write, upload, commitUpload, canEdit, context, onUploadState = () => {}}) {
    const doc = preview.ownerDocument, win = doc.defaultView;
    const canvas = doc.createElement('canvas'), measure = canvas.getContext('2d');
    let state = null, selection = '', drag = null, uploading = false, destroyed = false, imageContext = '';
    const imageSession=win.crypto?.randomUUID?.() || Date.now().toString(36)+Math.random().toString(36).slice(2);
    let imageEpoch=0;
    const listeners = [], on = (node,type,fn) => {node.addEventListener(type,fn); listeners.push(()=>node.removeEventListener(type,fn));};
    const q = key => toolbar.querySelector('[data-pl-edit="'+key+'"]');
    toolbar.innerHTML = '<p class="spl-edit-intro">Text oder Bild auswählen · Rechtsklick öffnet die Formatierung · Ziehen verschiebt, der Griff rechts unten ändert die Größe.</p><button type="button" data-pl-edit="add-text">+ Textfeld</button><label class="spl-element-picker">Element auswählen<select data-pl-edit="element" aria-label="Textfeld, Logo oder eigenes Bild auswählen"><option value="">Im Schild auswählen</option></select></label>' +
      '<div class="spl-element-toolbar" hidden><header><strong data-pl-edit="title"></strong><button type="button" data-pl-edit="reset">Zurücksetzen</button><button type="button" data-pl-edit="remove" hidden>Bild entfernen</button><button type="button" data-pl-edit="close" aria-label="Elementauswahl schließen">×</button></header>' +
      '<div class="spl-element-fields"><label data-pl-edit="font-label">Schriftart<select data-pl-edit="font">'+Fonts.families.map(f=>'<option value="'+f.id+'">'+esc(f.label)+'</option>').join('')+'</select></label><label data-pl-edit="size-label">Schriftgröße (pt)<input data-pl-edit="size" type="number" min="5" max="120" step="0.5"></label>'+
      '<label data-pl-edit="bold-label">Schriftschnitt<select data-pl-edit="bold"><option value="false">Normal</option><option value="true">Fett</option></select></label><label data-pl-edit="color-label">Textfarbe<input data-pl-edit="color" type="color"></label><label data-pl-edit="align-label">Ausrichtung<select data-pl-edit="align"><option value="left">Links</option><option value="center">Mitte</option><option value="right">Rechts</option></select></label><label class="spl-edit-text" data-pl-edit="text-label" hidden>Text<textarea data-pl-edit="text" maxlength="1000" rows="3"></textarea></label>'+
      [['xMm','X (mm)'],['yMm','Y (mm)'],['widthMm','Breite (mm)'],['heightMm','Höhe (mm)']].map(([key,label])=>'<label>'+label+'<input data-pl-edit="'+key+'" type="number" min="0" max="500" step="0.5"></label>').join('')+'</div></div>';
    images.innerHTML = '<div class="spl-image-header"><strong>Eigene Bilder <small data-pl-image-count>0 / 3</small></strong><label class="spl-upload-button">Bild hinzufügen<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-pl-image-input></label></div><p class="spl-hint">Bis zu 3 Bilder · PNG, JPG, WebP oder unbewegtes GIF · höchstens 10 MB je Datei. In Vorlagen und Standardeinstellungen mitspeichern.</p><div class="spl-image-list"></div><p class="spl-hint" data-pl-image-status role="status"></p>';
    const imageInput = images.querySelector('[data-pl-image-input]'), imageStatus = images.querySelector('[data-pl-image-status]');
    const measurePt=(text,fontId,size,bold)=>{measure.font=(bold?'700 ':'400 ')+size+'px "'+Fonts.get(fontId).cssFamily+'"';return measure.measureText(text).width;};
    const editable = () => !destroyed && state?.editable && canEdit();
    function effectiveBox(id, value = state?.value) {
      if (!value || !id) return null;
      if (id === 'logo') {
        const box = Design.getContentGeometry(value,{hasLogo:Boolean(state?.logo)}).logoBox;
        return value.logoMode === 'free' ? {xMm:value.logoXmm,yMm:value.logoYmm,widthMm:value.logoWidthMm,heightMm:value.logoHeightMm} : box;
      }
      if (id.startsWith('image:')) return value.imageBoxes.find(row=>row.assetId===id.slice(6));
      if(id.startsWith('text:'))return value.freeTextBoxes.find(row=>row.id===id.slice(5));
      const box=Design.create(value,state?.article || {},{hasLogo:Boolean(state?.logo),hasPhoto:Boolean(state?.photo)})[id];
      if(!box || box.override)return box;
      const fitted=Design.layoutText(textValues(value,state?.article,state?.price)[id],box,measurePt);
      return {...box,fontSizePt:fitted.fontSizePt};
    }
    function focusSelection(resize = false) {
      const node = [...preview.querySelectorAll('[data-pl-element]')].find(node=>node.dataset.plElement===selection);
      (resize ? node?.querySelector('[data-pl-element-resize]') : node)?.focus({preventScroll:true});
    }
    function updateToolbar() {
      const box = effectiveBox(selection), free=selection.startsWith('text:'),text = Object.hasOwn(names,selection)||free, image = selection.startsWith('image:');
      toolbar.querySelector('.spl-element-toolbar').hidden = !box;
      q('title').textContent = free?'Eigenes Textfeld':text ? names[selection] : selection==='logo' ? 'Branding-Logo' : 'Eigenes Bild';
      q('font-label').hidden = q('size-label').hidden = !text;
      for(const key of ['bold','color','align'])q(key+'-label').hidden=!text;q('text-label').hidden=!free;
      q('remove').hidden = !image&&!free;q('remove').textContent=free?'Textfeld entfernen':'Bild entfernen';q('reset').hidden = !text||free;
      q('element').value=selection;
      for (const [key,value] of Object.entries({font:box?.fontId,size:box?.fontSizePt,bold:box?.bold,color:box?.color,align:box?.align,text:box?.text,xMm:box?.xMm,yMm:box?.yMm,widthMm:box?.widthMm,heightMm:box?.heightMm})) {
        if (value !== undefined && doc.activeElement !== q(key)) q(key).value = typeof value==='number'?String(Math.round(value*100)/100):String(value);
      }
      toolbar.querySelectorAll('input,select,button').forEach(node=>{node.disabled = !editable();});
      // Closing selection is available even for a received, read-only template.
      q('close').disabled = false;
      q('element').disabled=false;
      q('add-text').disabled=!editable()||state?.value.freeTextBoxes.length>=20;
    }
    function select(id) {
      selection = id; preview.querySelectorAll('[data-pl-element]').forEach(node=>node.classList.toggle('is-selected',node.dataset.plElement===id));
      images.querySelectorAll('[data-pl-choose-image]').forEach(node=>node.classList.toggle('is-selected',node.dataset.plChooseImage===id));
      updateToolbar();
    }
    function applyBox(id, box, base = read(), announce = true) {
      if (!editable()) return;
      const bounded = Design.boundedBox(base,box);
      let next;
      if (id==='logo') next = {...base,logoMode:'free',logoXmm:bounded.xMm,logoYmm:bounded.yMm,logoWidthMm:Math.max(5,bounded.widthMm),logoHeightMm:Math.max(5,bounded.heightMm)};
      else if (id.startsWith('image:')) next = {...base,imageBoxes:base.imageBoxes.map(row=>row.assetId===id.slice(6)?{assetId:row.assetId,...bounded}:row)};
      else if(id.startsWith('text:'))next={...base,freeTextBoxes:base.freeTextBoxes.map(row=>row.id===id.slice(5)?{...row,...bounded,fontId:box.fontId,fontSizePt:box.fontSizePt,bold:box.bold,color:box.color,align:box.align,text:box.text}:row)};
      else next = {...base,textBoxes:{...base.textBoxes,[id]:{fontId:box.fontId,fontSizePt:box.fontSizePt,...bounded,bold:box.bold,color:box.color,align:box.align}}};
      write(next); selection=id;
      if (announce) live.textContent=(names[id] || (id==='logo'?'Logo':'Bild'))+': X '+bounded.xMm+', Y '+bounded.yMm+' mm · '+bounded.widthMm+' × '+bounded.heightMm+' mm.';
      updateToolbar();
    }
    const pct = (n,total) => (n/total*100)+'%';
    function geometry(node,box,value) {for(const [css,key,total] of [['left','xMm',value.labelWidthMm],['top','yMm',value.labelHeightMm],['width','widthMm',value.labelWidthMm],['height','heightMm',value.labelHeightMm]]) node.style[css]=pct(box[key],total);}
    function addElement(label,id,box,description) {
      const node=doc.createElement('div'); node.className='spl-design-element'+(selection===id?' is-selected':''); node.dataset.plElement=id;
      node.tabIndex=state.editable?0:-1; node.setAttribute('role','group'); node.setAttribute('aria-label',description+' auswählen und verschieben');
      geometry(node,box,state.value);
      if(state.editable){const handle=doc.createElement('button');handle.type='button';handle.className='spl-element-resize';handle.dataset.plElementResize='';handle.setAttribute('aria-label',description+' Größe ändern');node.append(handle);}
      label.append(node);return node;
    }
    function render(nextState) {
      if(destroyed)return; const focused=preview.contains(doc.activeElement)?doc.activeElement.closest('[data-pl-element]')?.dataset.plElement:null;
      const focusedResize=focused && doc.activeElement.hasAttribute('data-pl-element-resize');
      state=nextState; const value=state.value;
      const nextContext=context(), existingImages=imageContext===nextContext
        ? new Map([...preview.querySelectorAll('img[data-pl-image-key]')].map(node=>[node.dataset.plImageKey,node])) : new Map();
      if(imageContext!==nextContext)imageEpoch++;
      imageContext=nextContext;
      function imageNode(key,src,alt,className='') {
        const image=existingImages.get(key) || doc.createElement('img');image.dataset.plImageKey=key;
        // Force a fresh authorization after account/draft changes. Browsers may
        // otherwise reuse a decoded no-store image while its old node is alive.
        const source=key.startsWith('image:') ? src+(src.includes('?')?'&':'?')+'preview='+imageSession+'-'+imageEpoch : src;
        if(image.getAttribute('src')!==source)image.src=source;
        image.alt=alt;image.className=className;image.draggable=false;return image;
      }
      const label=doc.createElement('article'); label.className='spl-label spl-direct-label spl-design-'+value.design+' spl-shape-'+value.shape+(value.showBorder?' spl-border-on':' spl-border-off');
      label.style.setProperty('--spl-aspect',String(value.labelWidthMm/value.labelHeightMm));label.style.setProperty('--spl-accent',value.color);
      label.style.setProperty('--spl-outline-width',(.18/value.labelWidthMm*100)+'cqi');
      if(value.shape==='rounded')label.style.borderRadius=(Math.min(3,value.labelWidthMm*.1,value.labelHeightMm*.1)/value.labelWidthMm*100)+'cqi';
      label.style.setProperty('--spl-circle-width',pct(Math.min(value.labelWidthMm,value.labelHeightMm),value.labelWidthMm));label.style.setProperty('--spl-circle-height',pct(Math.min(value.labelWidthMm,value.labelHeightMm),value.labelHeightMm));
      const boxes=Design.create(value,state.article || {},{hasLogo:Boolean(state.logo),hasPhoto:Boolean(state.photo)}), texts=textValues(value,state.article,state.price);
      const contentGeometry=Design.getContentGeometry(value,{hasLogo:Boolean(state.logo),hasPhoto:Boolean(state.photo)}), clipped=[];
      if(value.design==='classic') {const band=doc.createElement('div');band.className='spl-promo-band';geometry(band,{xMm:0,yMm:0,widthMm:value.labelWidthMm,heightMm:1.2},value);label.append(band);}
      if(value.design==='promo') {const band=doc.createElement('div');band.className='spl-promo-band';geometry(band,contentGeometry.promoBand,value);label.append(band);}
      function addLogo() {const box=effectiveBox('logo');if(!box)return;const node=addElement(label,'logo',box,'Logo '+state.logo.label);node.dataset.plLogo='';node.classList.add('spl-logo-editable','spl-direct-logo');if(value.logoMode==='reserved')node.style.zIndex='0';node.prepend(imageNode('logo',state.logo.url,state.logo.label,'spl-label-logo'));const handle=node.querySelector('[data-pl-element-resize]');if(handle)handle.dataset.plLogoResize='';}
      if(state.logo && value.logoMode==='reserved')addLogo();
      function addPhoto() {
        if(!state.photo)return;
        const photo=imageNode('photo',state.photo,state.article?.description || 'Artikelfoto','spl-label-photo spl-direct-photo');
        geometry(photo,contentGeometry.photoBox,value);label.append(photo);
      }
      for(const id of ['headline','brand','description','price','tax','articleNumber','ean','footer']) {
        if(id==='description')addPhoto();
        const box=boxes[id];
        if(!box.visible || !texts[id])continue;
        const node=addElement(label,id,box,names[id]), content=doc.createElement('div');content.className='spl-element-text';
        const fitted=Design.layoutText(texts[id],box,measurePt);
        if(fitted.clipped)clipped.push(names[id]);
        content.style.fontFamily='"'+Fonts.get(box.fontId).cssFamily+'"';content.style.fontWeight=box.bold?'700':'400';content.style.color=box.color;
        content.style.textAlign=box.align || 'center';content.style.fontSize=(fitted.fontSizePt*.352777778/value.labelWidthMm*100)+'cqi';
        content.style.lineHeight=(fitted.lineHeightPt/fitted.fontSizePt).toString();
        for(const line of fitted.lines){const row=doc.createElement('span');row.textContent=line || '\u00a0';content.append(row);}node.prepend(content);
      }
      for(const box of value.imageBoxes) {
        const node=addElement(label,'image:'+box.assetId,box,'Eigenes Bild');node.prepend(imageNode('image:'+box.assetId,'/api/sales/price-labels/images/'+encodeURIComponent(box.assetId),'Eigenes Bild'));node.classList.add('spl-design-image');
      }
      for(const box of value.freeTextBoxes){
        const node=addElement(label,'text:'+box.id,box,'Eigenes Textfeld'),content=doc.createElement('div');content.className='spl-element-text';
        const fitted=Design.layoutText(box.text,{...box,override:true},measurePt);if(fitted.clipped)clipped.push('Eigenes Textfeld');
        content.style.fontFamily='"'+Fonts.get(box.fontId).cssFamily+'"';content.style.fontWeight=box.bold?'700':'400';content.style.color=box.color;content.style.textAlign=box.align;
        content.style.fontSize=(fitted.fontSizePt*.352777778/value.labelWidthMm*100)+'cqi';content.style.lineHeight='1.22';
        for(const line of fitted.lines){const row=doc.createElement('span');row.textContent=line||'\u00a0';content.append(row);}node.prepend(content);
      }
      if(state.logo && value.logoMode==='free')addLogo();
      preview.replaceChildren(label);
      q('element').replaceChildren(...[['','Im Schild auswählen'],...Object.entries(boxes).filter(([id,box])=>box.visible&&texts[id]).map(([id])=>[id,names[id]]),...(state.logo?[['logo','Branding-Logo']]:[]),...value.imageBoxes.map((box,index)=>['image:'+box.assetId,'Eigenes Bild '+(index+1)]),...value.freeTextBoxes.map((box,index)=>['text:'+box.id,'Textfeld '+(index+1)])].map(([id,name])=>{const option=doc.createElement('option');option.value=id;option.textContent=name;return option;}));
      let warning=toolbar.querySelector('.spl-clip-warning');if(!warning){warning=doc.createElement('p');warning.className='spl-clip-warning';warning.setAttribute('role','status');toolbar.append(warning);}
      warning.hidden=!clipped.length;warning.textContent=clipped.length?'Text passt nicht vollständig: '+clipped.join(', ')+'. Feld vergrößern oder Schriftgröße verkleinern.':'';
      if(selection && !effectiveBox(selection))selection='';
      updateToolbar();
      images.querySelector('[data-pl-image-count]').textContent=value.imageBoxes.length+' / 3';
      imageInput.disabled=!editable() || uploading || value.imageBoxes.length>=3;
      images.querySelector('.spl-upload-button').classList.toggle('is-disabled',imageInput.disabled);
      const list=images.querySelector('.spl-image-list');list.replaceChildren(...value.imageBoxes.map((box,index)=>{const button=doc.createElement('button');button.type='button';button.dataset.plChooseImage='image:'+box.assetId;button.textContent='Bild '+(index+1);button.disabled=!state.editable;button.classList.toggle('is-selected',selection==='image:'+box.assetId);return button;}));
      if(focused && state.editable && editable()) {const node=[...preview.querySelectorAll('[data-pl-element]')].find(node=>node.dataset.plElement===focused);(focusedResize?node?.querySelector('[data-pl-element-resize]'):node)?.focus({preventScroll:true});}
    }
    function finish(event,cancel=false) {
      if(!drag || event && event.pointerId!==undefined && event.pointerId!==drag.pointerId)return;
      const before=drag;drag=null;try{preview.releasePointerCapture(before.pointerId);}catch{}
      if(before.context!==context() || !editable())return;
      if(cancel && before.moved){write(before.options);live.textContent='Elementänderung verworfen.';}focusSelection(before.resize);
    }
    on(preview,'pointerdown',event=>{
      const node=event.target.closest?.('[data-pl-element]');if(!node || !editable() || drag || event.isPrimary===false || event.button!==0)return;
      select(node.dataset.plElement);const options=read(),box=effectiveBox(selection,options),frame=node.closest('.spl-label').getBoundingClientRect();
      drag={id:selection,options,box:{...box},context:context(),resize:Boolean(event.target.closest('[data-pl-element-resize]')),pointerId:event.pointerId,x:event.clientX,y:event.clientY,width:frame.width,height:frame.height,moved:false};
      event.preventDefault();try{preview.setPointerCapture(event.pointerId);}catch{}focusSelection(drag.resize);
    });
    on(preview,'pointermove',event=>{
      if(!drag || event.pointerId!==drag.pointerId || !editable() || context()!==drag.context)return;
      const dx=(event.clientX-drag.x)/drag.width*drag.options.labelWidthMm,dy=(event.clientY-drag.y)/drag.height*drag.options.labelHeightMm;
      if(!drag.moved && Math.abs(event.clientX-drag.x)+Math.abs(event.clientY-drag.y)<2)return;
      event.preventDefault();drag.moved=true;const box={...drag.box};
      if(drag.resize){box.widthMm=Math.max(drag.id==='logo'?5:1,Math.min(drag.options.labelWidthMm-box.xMm,box.widthMm+dx));box.heightMm=Math.max(drag.id==='logo'?5:1,Math.min(drag.options.labelHeightMm-box.yMm,box.heightMm+dy));}
      else{box.xMm+=dx;box.yMm+=dy;}applyBox(drag.id,box,drag.options,false);
    });
    on(preview,'pointerup',event=>finish(event));on(preview,'pointercancel',event=>finish(event,true));on(preview,'lostpointercapture',event=>finish(event));
    on(preview,'focusin',event=>{const node=event.target.closest?.('[data-pl-element]');if(node)select(node.dataset.plElement);});
    on(preview,'keydown',event=>{
      if(event.key==='F10'&&event.shiftKey){openContext(event);return;}
      if(event.key==='Escape'){event.preventDefault();if(drag)finish(null,true);else select('');return;}
      const node=event.target.closest?.('[data-pl-element]');if(!node || !editable() || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;
      event.preventDefault();select(node.dataset.plElement);const box={...effectiveBox(selection)},step=event.shiftKey?5:.5;
      const dx=event.key==='ArrowRight'?step:event.key==='ArrowLeft'?-step:0,dy=event.key==='ArrowDown'?step:event.key==='ArrowUp'?-step:0;
      const resize=Boolean(event.target.closest('[data-pl-element-resize]'));if(resize){box.widthMm=Math.max(selection==='logo'?5:1,box.widthMm+dx);box.heightMm=Math.max(selection==='logo'?5:1,box.heightMm+dy);}else{box.xMm+=dx;box.yMm+=dy;}
      applyBox(selection,box);focusSelection(resize);
    });
    on(toolbar,'change',event=>{
      if(event.target===q('element')) { select(event.target.value);focusSelection();return; }
      if(!editable() || !effectiveBox(selection))return;const box={...effectiveBox(selection)},key=event.target.dataset.plEdit;
      if(key==='font')box.fontId=event.target.value;else if(key==='size')box.fontSizePt=Number(event.target.value);else if(key==='bold')box.bold=event.target.value==='true';else if(['color','align','text'].includes(key))box[key]=event.target.value;else if(['xMm','yMm','widthMm','heightMm'].includes(key))box[key]=Number(event.target.value);else return;
      try{if(Object.values(box).some(value=>typeof value==='number' && !Number.isFinite(value)))throw new Error('Bitte eine gültige Größe und Position eingeben.');applyBox(selection,box);}catch(error){live.textContent=error.message;event.target.value=effectiveBox(selection)[key==='font'?'fontId':key==='size'?'fontSizePt':key];}
    });
    const panel=toolbar.querySelector('.spl-element-toolbar');panel.setAttribute('role','dialog');panel.setAttribute('aria-label','Element formatieren');
    function closeContext(){panel.classList.remove('is-context');panel.style.left=panel.style.top='';}
    function openContext(event){const node=event.target.closest?.('[data-pl-element]');if(!node||!editable())return;event.preventDefault();select(node.dataset.plElement);panel.classList.add('is-context');const rect=panel.getBoundingClientRect();panel.style.left=Math.max(8,Math.min(event.clientX||node.getBoundingClientRect().left,win.innerWidth-rect.width-8))+'px';panel.style.top=Math.max(8,Math.min(event.clientY||node.getBoundingClientRect().top,win.innerHeight-rect.height-8))+'px';q(selection.startsWith('image:')||selection==='logo'?'xMm':'font').focus();}
    on(preview,'contextmenu',openContext);
    on(doc,'pointerdown',event=>{if(!panel.contains(event.target))closeContext();});on(win,'resize',closeContext);on(toolbar,'keydown',event=>{if(event.key==='Escape'){closeContext();select('');focusSelection();}});
    on(q('close'),'click',()=>{closeContext();select('');});
    on(q('add-text'),'click',()=>{if(!editable())return;const base=read();if(base.freeTextBoxes.length>=20)return;const id=win.crypto.randomUUID();selection='text:'+id;write({...base,freeTextBoxes:[...base.freeTextBoxes,{id,text:'Neuer Text',fontId:base.fontId,fontSizePt:10,bold:false,color:'#12221C',align:'left',...Design.boundedBox(base,{xMm:4,yMm:4,widthMm:Math.min(40,base.labelWidthMm-4),heightMm:Math.min(12,base.labelHeightMm-4)})}]});updateToolbar();q('text').focus();q('text').select();});
    on(q('reset'),'click',()=>{if(!editable() || !Object.hasOwn(names,selection))return;const base=read(),textBoxes={...base.textBoxes};delete textBoxes[selection];write({...base,textBoxes});updateToolbar();});
    on(q('remove'),'click',()=>{if(!editable())return;const base=read(),id=selection;selection='';if(id.startsWith('image:'))write({...base,imageBoxes:base.imageBoxes.filter(row=>row.assetId!==id.slice(6))});else if(id.startsWith('text:'))write({...base,freeTextBoxes:base.freeTextBoxes.filter(row=>row.id!==id.slice(5))});live.textContent='Element aus diesem Entwurf entfernt.';});
    on(images,'click',event=>{const button=event.target.closest?.('[data-pl-choose-image]');if(button){select(button.dataset.plChooseImage);focusSelection();}});
    on(imageInput,'change',async()=>{
      const file=imageInput.files?.[0];imageInput.value='';if(!file || !editable() || uploading)return;
      if(file.size>10*1024*1024){imageStatus.textContent='Die Datei ist größer als 10 MB.';return;}
      if(read().imageBoxes.length>=3){imageStatus.textContent='Höchstens drei eigene Bilder sind möglich.';return;}
      const ticket=context();uploading=true;imageStatus.textContent='Bild wird geprüft und geladen …';onUploadState(true);render(state);
      try{const asset=await upload(file);
        if(commitUpload){const inserted=await commitUpload(asset,ticket);if(!destroyed)imageStatus.textContent=inserted?'Bild eingefügt. Der Arbeitsentwurf wird automatisch gesichert.':'Bild fertig hochgeladen. Über „Hochgeladene Bilder“ wieder einfügen.';return;}
        if(destroyed || !editable() || context()!==ticket)return;const base=read();if(base.imageBoxes.length>=3)throw new Error('Höchstens drei eigene Bilder sind möglich.');
        const width=Math.min(base.labelWidthMm/3,30),height=Math.min(base.labelHeightMm/3,width/(asset.width/asset.height));
        const box={assetId:asset.assetId,...Design.boundedBox(base,{xMm:4,yMm:4,widthMm:width,heightMm:height})};selection='image:'+asset.assetId;write({...base,imageBoxes:[...base.imageBoxes,box]});imageStatus.textContent='Bild eingefügt. Mit der Vorlage oder Standardeinstellung speichern.';
      }catch(error){if(!destroyed && context()===ticket)imageStatus.textContent=error.message;}finally{uploading=false;if(!destroyed){onUploadState(false);if(state)render(state);}}
    });
    const fontsReady=()=>{if(!destroyed && state)render(state);};doc.fonts?.ready?.then(fontsReady);if(doc.fonts?.addEventListener)on(doc.fonts,'loadingdone',fontsReady);
    return {render,clear(){closeContext();finish(null);selection='';if(state)render(state);},destroy(){destroyed=true;closeContext();finish(null);listeners.forEach(off=>off());preview.replaceChildren();toolbar.replaceChildren();images.replaceChildren();}};
  }
  return {mount,textValues,names};
});
