(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GrabenplanerPriceLabelProject=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,MAX_BYTES=512*1024;
 const PAPER_KEYS=['paper','paperWidthMm','paperHeightMm','orientation','marginMm','gapMm'];
 const plain=v=>v&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
 function exact(v,keys){if(!plain(v)||keys.some(k=>!Object.hasOwn(v,k))||Object.keys(v).some(k=>!keys.includes(k)))throw new TypeError('Das Preisschildprojekt ist ungültig.');}
 function text(v,max){if(typeof v!=='string'||v.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v))throw new TypeError('Der Projekttext ist ungültig.');return v;}
 function normalize(input,normalizeOptions){
  exact(input,['schemaVersion','name','labels','selectedLabelId','paper','filenameOptions']);
  if(input.schemaVersion!==1||!Array.isArray(input.labels)||input.labels.length>100||typeof input.selectedLabelId!=='string')throw new TypeError('Das Projekt darf höchstens 100 Entwürfe enthalten.');
  exact(input.paper,PAPER_KEYS);const checkedPaper=normalizeOptions(input.paper),paper=Object.fromEntries(PAPER_KEYS.map(k=>[k,checkedPaper[k]])),ids=new Set();
  const labels=input.labels.map(label=>{exact(label,['id','articleNumber','priceType','options']);
   if(!UUID.test(label.id)||ids.has(label.id)||!plain(label.options)||!['sales','internet_1','internet_3'].includes(label.priceType)||typeof label.articleNumber!=='string'||!label.articleNumber||label.articleNumber.length>80||/[\s,;\u0000-\u001f\u007f]/u.test(label.articleNumber))throw new TypeError('Ein Schild im Projekt ist ungültig.');
   ids.add(label.id);return{id:label.id,articleNumber:label.articleNumber,priceType:label.priceType,options:normalizeOptions({...label.options,...paper})};});
  if(input.selectedLabelId&&!ids.has(input.selectedLabelId)||labels.length&&!input.selectedLabelId)throw new TypeError('Die Schildauswahl im Projekt ist ungültig.');
  exact(input.filenameOptions,['stamp','position','separator','suffix']);const f=input.filenameOptions;
  if(!['none','date','date-time','date-suffix'].includes(f.stamp)||!['before','after'].includes(f.position)||!['-','_',' '].includes(f.separator))throw new TypeError('Die Dateinamenoptionen sind ungültig.');
  const result={schemaVersion:1,name:text(input.name,110),labels,selectedLabelId:input.selectedLabelId,paper,filenameOptions:{...f,suffix:text(f.suffix,40)}};
  if(new TextEncoder().encode(JSON.stringify(result)).length>MAX_BYTES)throw new TypeError('Das Projekt ist zu groß. Bitte weniger Schilder oder Text verwenden.');return result;
 }
 function paperLayout(project){
  const p=project.paper,sizes={A4:[210,297],A5:[148,210],A6:[105,148]},base=p.paper==='custom'?[p.paperWidthMm,p.paperHeightMm]:sizes[p.paper];
  const [width,height]=p.orientation==='landscape'?[Math.max(...base),Math.min(...base)]:[Math.min(...base),Math.max(...base)];
  const cells=[],epsilon=1e-8;let page=0,x=p.marginMm,y=p.marginMm,rowHeight=0;
  for(const label of project.labels)for(let copy=0;copy<label.options.copies;copy++){
   const w=label.options.labelWidthMm,h=label.options.labelHeightMm;
   if(w>width-2*p.marginMm+epsilon||h>height-2*p.marginMm+epsilon)throw new TypeError('Ein Schild passt nicht auf das eingestellte Papier.');
   if(x+w>width-p.marginMm+epsilon){x=p.marginMm;y+=rowHeight+p.gapMm;rowHeight=0;}
   if(y+h>height-p.marginMm+epsilon){page++;x=p.marginMm;y=p.marginMm;rowHeight=0;}
   cells.push({labelId:label.id,copyIndex:copy,page,x,y,width:w,height:h});x+=w+p.gapMm;rowHeight=Math.max(rowHeight,h);
   if(cells.length>1000||page>=200)throw new TypeError('Der Export darf höchstens 1000 Schilder und 200 Seiten enthalten.');
  }
  return{width,height,pageCount:cells.length?page+1:0,cells};
 }
 return{normalize,paperLayout,UUID,MAX_BYTES,PAPER_KEYS};
});
