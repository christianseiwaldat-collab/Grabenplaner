'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),express=require('express');
const Model=require('../public/sales-price-label-project'),Ui=require('../public/sales-price-labels'),Pdf=require('../lib/sales-price-labels-pdf');
const T=require('../lib/sales-price-label-template-store'), {createSalesPriceLabelProjectStore}=require('../lib/sales-price-label-project-store');
const {createSalesPriceLabelDraftStore}=require('../lib/sales-price-label-draft-store'),{registerSalesPriceLabelsRoutes}=require('../lib/sales-price-labels-routes');
const options=extra=>Ui.normalizeOptions(extra),label=(number='107506',extra={})=>({id:crypto.randomUUID(),articleNumber:number,priceType:'sales',options:options(extra)});
function project(labels=[label(),label()]){return{schemaVersion:1,name:'Private individual labels',labels,selectedLabelId:labels[0]?.id||'',paper:{paper:'A4',paperWidthMm:210,paperHeightMm:297,orientation:'portrait',marginMm:10,gapMm:3},filenameOptions:{stamp:'none',position:'before',separator:'-',suffix:''}};}
const context=number=>T.resolveTemplateSessionContext({employeeNumber:number,isEmployee:true,sessionKind:'employee',permissions:[],scopes:[]},{listBranchAccounts:async()=>[],getEmployeeHomeLocation:async()=>null});
test('UUID label variants retain independent text/images while project bounds and mixed paper placement remain exact',()=>{
 const a=label('107506',{labelWidthMm:90,labelHeightMm:60}),b=label('107506',{labelWidthMm:148,labelHeightMm:210,copies:2,fontId:'spectral'}),p=project([a,b]),n=Model.normalize(p,Ui.normalizeOptions);
 assert.equal(n.labels[1].articleNumber,n.labels[0].articleNumber);assert.notEqual(n.labels[1].id,n.labels[0].id);assert.equal(n.labels[1].options.fontId,'spectral');
 const plan=Model.paperLayout(n);assert.equal(plan.cells.length,3);assert.equal(plan.pageCount,2);for(const c of plan.cells){assert.ok(c.x>=10&&c.y>=10&&c.x+c.width<=200.001&&c.y+c.height<=287.001);}
 for(const bad of [{...p,ownerId:'forged'},{...p,labels:[a,a]},{...p,selectedLabelId:crypto.randomUUID()},{...p,labels:[{...a,priceGross:'1'}]},{...p,labels:[{...a,options:null}]}])assert.throws(()=>Model.normalize(bad,Ui.normalizeOptions));
 assert.throws(()=>Model.paperLayout(Model.normalize(project([label('1',{labelWidthMm:500})]),Ui.normalizeOptions)));
});

test('uniform individual projects retain the exact decimal legacy grid and reject even slightly oversized paper slots',()=>{
 const labels=Array.from({length:3},(_,i)=>label(String(i+1),{labelWidthMm:62.125,labelHeightMm:48.375,copies:13})),p=Model.normalize(project(labels),Ui.normalizeOptions),plan=Model.paperLayout(p),legacy=require('../public/sales-price-label-layout').create(p.labels[0].options,3);
 assert.equal(plan.pageCount,legacy.pageCount);assert.equal(plan.cells.length,legacy.labelCount);plan.cells.forEach((cell,index)=>{const slot=legacy.slot(index);for(const field of ['page','x','y','width','height','copyIndex'])assert.ok(Math.abs(cell[field]-slot[field])<1e-8,field);});
 const tooWide=Model.normalize(project([label('1',{labelWidthMm:190.0001})]),Ui.normalizeOptions);assert.equal(require('../public/sales-price-label-layout').create(tooWide.labels[0].options,1).capacity,0);assert.throws(()=>Model.paperLayout(tooWide));
});
test('mixed-label PDF uses the same paper plan, independent fonts and text, copies, and current server prices',async()=>{
 const a=label('107506',{fontId:'roboto',freeTextBoxes:[{id:crypto.randomUUID(),text:'First custom text',fontId:'roboto',fontSizePt:8,bold:false,color:'#223344',align:'left',xMm:4,yMm:50,widthMm:70,heightMm:6}]}),b=label('107506',{labelWidthMm:148,labelHeightMm:210,fontId:'spectral',copies:2,headline:'Second variant'}),p=Model.normalize(project([a,b]),Ui.normalizeOptions);
 const instances=p.labels.map((l,index)=>({id:l.id,options:l.options,item:{articleNumber:l.articleNumber,description:'Current article',priceGross:index?'149.00':'129.00',taxRate:'20'}}));
 const bytes=await Pdf.createSalesPriceLabelsPdf({instances,options:instances[0].options});const{getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs'),task=getDocument({data:new Uint8Array(bytes),isEvalSupported:false}),pdf=await task.promise;
 try{assert.equal(pdf.numPages,Model.paperLayout(p).pageCount);const texts=[];for(let index=1;index<=pdf.numPages;index++){const page=await pdf.getPage(index);texts.push((await page.getTextContent()).items.map(i=>i.str).join(' '));assert.ok(Math.abs(page.view[2]-210*Pdf.MM)<.001);assert.ok(Math.abs(page.view[3]-297*Pdf.MM)<.001);}assert.match(texts[0],/129,00/);assert.match(texts[0],/First custom text/);assert.match(texts[0],/149,00/);assert.match(texts[0],/Second variant/);assert.match(texts[1],/149,00/);}finally{await task.destroy();}
});
