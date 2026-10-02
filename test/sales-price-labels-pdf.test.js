'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),sharp=require('sharp');
const {createSalesPriceLabelsPdf,normalizeOptions,MM}=require('../lib/sales-price-labels-pdf');
const article=(overrides={})=>({articleNumber:'001234',description:'Fujifilm X-T50 Gehäuse silber',brand:'Fujifilm',priceGross:'1599.005',taxRate:'20',ean:'4547410533644',...overrides});
async function inspect(buffer){
  const {getDocument,OPS}=await import('pdfjs-dist/legacy/build/pdf.mjs'),task=getDocument({data:new Uint8Array(buffer),isEvalSupported:false}),pdf=await task.promise;
  try{const pages=[];for(let i=1;i<=pdf.numPages;i++){
    const page=await pdf.getPage(i),content=await page.getTextContent(),operators=await page.getOperatorList(),imageRects=[],fillRects=[];
    let matrix=[1,0,0,1,0,0],fillColor='';const stack=[];
    function rectFromPoints(points){const xs=points.map(point=>point[0]),ys=points.map(point=>point[1]);return{x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)};}
    for(let index=0;index<operators.fnArray.length;index++){
      const code=operators.fnArray[index],args=operators.argsArray[index];
      if(code===OPS.save)stack.push({matrix:matrix.slice(),fillColor});
      else if(code===OPS.restore){const prior=stack.pop();matrix=prior?.matrix||[1,0,0,1,0,0];fillColor=prior?.fillColor||'';}
      else if(code===OPS.transform){const[a,b,c,d,e,f]=matrix,[g,h,j,k,l,m]=args;matrix=[a*g+c*h,b*g+d*h,a*j+c*k,b*j+d*k,a*l+c*m+e,b*l+d*m+f];}
      else if(code===OPS.setFillRGBColor)fillColor=String(args[0]).toLowerCase();
      else if(code===OPS.constructPath&&args[0]===OPS.fill&&args[2]){
        const[a,b,c,d,e,f]=matrix,[x1,y1,x2,y2]=args[2],points=[[x1,y1],[x2,y1],[x1,y2],[x2,y2]].map(([x,y])=>[a*x+c*y+e,b*x+d*y+f]);
        fillRects.push({...rectFromPoints(points),color:fillColor});
      }
      else if([OPS.paintImageXObject,OPS.paintInlineImageXObject].includes(code)){
        const[a,b,c,d,e,f]=matrix,points=[[e,f],[a+e,b+f],[c+e,d+f],[a+c+e,b+d+f]];
        imageRects.push({key:args[0],...rectFromPoints(points)});
      }
    }
    pages.push({items:content.items,text:content.items.map(item=>item.str).join(' '),width:page.view[2],height:page.view[3],images:imageRects.length,imageRects,fillRects});
  }return pages;}
  finally{await task.destroy();}
}
const overlaps=(a,b)=>Math.min(a.x+a.width,b.x+b.width)>Math.max(a.x,b.x)+.1&&Math.min(a.y+a.height,b.y+b.height)>Math.max(a.y,b.y)+.1;
const textRect=item=>({x:item.transform[4],y:item.transform[5]-item.height*.2,width:item.width,height:item.height});
const logoSvg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100" viewBox="0 0 400 100"><rect width="400" height="100" rx="12" fill="#143E73"/><text x="200" y="68" text-anchor="middle" fill="white" font-family="sans-serif" font-size="54">LOGO</text></svg>');
test('Label options are strict, repeatable and protect printable paper geometry',()=>{
  const options=normalizeOptions();assert.equal(options.paper,'A4');assert.equal(options.labelWidthMm,90);assert.equal(options.showPhoto,false);assert.deepEqual(normalizeOptions(options),options);
  for(const value of [null,[],{surprise:true},{copies:1.2},{copies:51},{showPhoto:'true'},{color:'red'},{color:'#123'},{labelWidthMm:Infinity},{labelHeightMm:9},{gapMm:51},{headline:'x'.repeat(71)},{footer:'x'.repeat(161)},{paper:'A7'},{orientation:'horizontal'}])assert.throws(()=>normalizeOptions(value),{code:'PRICE_LABEL_OPTIONS'});
  assert.throws(()=>normalizeOptions({paper:'A6'}),{code:'PRICE_LABEL_FIT'});
  assert.throws(()=>normalizeOptions({paper:'custom',paperWidthMm:90,paperHeightMm:60,labelWidthMm:90,labelHeightMm:60,marginMm:1}),{code:'PRICE_LABEL_FIT'});
  assert.equal(normalizeOptions({color:'#ffffff'}).color,'#FFFFFF');
  assert.equal(options.logoKitId,'');assert.equal(options.logoAssetKey,'');assert.equal(options.logoPosition,'top-left');assert.equal(options.logoWidthMm,20);assert.equal(options.logoHeightMm,10);assert.equal(options.logoSpacingMm,2);
  for(const value of [{logoKitId:'x'.repeat(121)},{logoAssetKey:'x'.repeat(161)},{logoPosition:'middle'},{logoWidthMm:4.9},{logoWidthMm:101},{logoHeightMm:0},{logoHeightMm:61},{logoSpacingMm:-1},{logoSpacingMm:11}])assert.throws(()=>normalizeOptions(value),{code:'PRICE_LABEL_OPTIONS'});
});
test('Multiple copied labels preserve exact decimal prices and all selected data across correctly sized pages',async()=>{
  const options={copies:5,headline:'NEU IM SORTIMENT',footer:'Beratung bei uns in der Filiale'},items=Array.from({length:3},(_,i)=>article({articleNumber:'00'+(1234+i)}));
  const pages=await inspect(await createSalesPriceLabelsPdf({items,options}));assert.equal(pages.length,2);
  assert.ok(Math.abs(pages[0].width-210*MM)<.001);assert.ok(Math.abs(pages[0].height-297*MM)<.001);
  const text=pages.map(page=>page.text).join(' ');assert.equal((text.match(/1\.599,01 €/g)||[]).length,15);
  assert.equal((text.match(/inkl\. 20 % MwSt\./g)||[]).length,15);assert.equal((text.match(/EAN 4547410533644/g)||[]).length,15);
  for(const item of items)assert.equal((text.match(new RegExp('Art. '+item.articleNumber,'g'))||[]).length,5);
  assert.equal((text.match(/NEU IM SORTIMENT/g)||[]).length,15);
  for(const page of pages)for(const item of page.items.filter(item=>item.str)){
    assert.ok(item.transform[4]>=10*MM-.01&&item.transform[4]+item.width<=page.width-10*MM+.01,item.str);
    assert.ok(item.transform[5]>10*MM&&item.transform[5]<page.height-10*MM,item.str);
  }
});
test('Unknown, negative and invalid prices are flagged and never silently become zero',async()=>{
  const items=[null,undefined,'','bad','-1','1e3',1].map((price,i)=>article({articleNumber:'CHECK-'+i,priceGross:price,taxRate:null}));
  const pages=await inspect(await createSalesPriceLabelsPdf({items,options:{showArticleNumber:false,showEan:false}})),text=pages.map(page=>page.text).join(' ');
  assert.equal((text.match(/Preis prüfen/g)||[]).length,items.length);assert.equal((text.match(/MwSt\. prüfen/g)||[]).length,items.length);assert.doesNotMatch(text,/0,00 €|EAN|Art\./);
  const zero=await inspect(await createSalesPriceLabelsPdf({items:[article({priceGross:'0',taxRate:'0'})]}));assert.match(zero[0].text,/0,00 €/);assert.match(zero[0].text,/inkl\. 0 % MwSt\./);
});
test('All designs and shapes render readable labels, with optional bounded photos and custom paper orientation',async()=>{
  const photo=await sharp({create:{width:240,height:180,channels:3,background:'#538D77'}}).webp().toBuffer(),buffers=[];
  for(const design of ['classic','minimal','promo'])for(const shape of ['rectangle','rounded','circle']){
    const options={paper:'custom',paperWidthMm:100,paperHeightMm:150,orientation:'landscape',labelWidthMm:90,labelHeightMm:70,marginMm:5,gapMm:3,design,shape,showPhoto:true,headline:'ANGEBOT',footer:'Nur solange der Vorrat reicht',color:design==='promo'?'#FFE17C':'#215345'};
    const buffer=await createSalesPriceLabelsPdf({items:[article({imageBuffer:photo})],options}),pages=await inspect(buffer);buffers.push({design,shape,buffer});
    assert.equal(pages.length,1);assert.equal(pages[0].images,1);assert.ok(Math.abs(pages[0].width-150*MM)<.001);assert.ok(Math.abs(pages[0].height-100*MM)<.001);assert.match(pages[0].text,/1\.599,01 €/);
  }
  const hidden=await inspect(await createSalesPriceLabelsPdf({items:[article({imageBuffer:Buffer.from('not a photo')})]}));assert.equal(hidden[0].images,0);
  for(const imageBuffer of [Buffer.from('invalid'),Buffer.alloc(50*1024+1)])await assert.rejects(createSalesPriceLabelsPdf({items:[article({imageBuffer})],options:{showPhoto:true}}),{code:'PRICE_LABEL_IMAGE'});
  if(process.env.PRICE_LABELS_PREVIEW_DIR){const fs=require('node:fs'),path=require('node:path');fs.mkdirSync(process.env.PRICE_LABELS_PREVIEW_DIR,{recursive:true});for(const result of buffers)fs.writeFileSync(path.join(process.env.PRICE_LABELS_PREVIEW_DIR,`labels-${result.design}-${result.shape}.pdf`),result.buffer);}
});
test('Limits prevent excessive pages and labels, and small labels fail clearly instead of clipping values',async()=>{
  await assert.rejects(createSalesPriceLabelsPdf({items:[]}),{code:'PRICE_LABEL_INPUT'});
  await assert.rejects(createSalesPriceLabelsPdf({items:Array.from({length:21},()=>article()),options:{copies:50}}),{code:'PRICE_LABEL_LIMIT',status:413});
  await assert.rejects(createSalesPriceLabelsPdf({items:Array.from({length:201},()=>article()),options:{paper:'custom',paperWidthMm:100,paperHeightMm:70,orientation:'landscape',labelWidthMm:90,labelHeightMm:60,marginMm:5,gapMm:0}}),{code:'PRICE_LABEL_LIMIT',status:413});
  await assert.rejects(createSalesPriceLabelsPdf({items:[article()],options:{labelWidthMm:10,labelHeightMm:10}}),{code:'PRICE_LABEL_FIT'});
  await assert.rejects(createSalesPriceLabelsPdf({items:[article({priceGross:'123456789012345678901234567890'})],options:{labelWidthMm:30,labelHeightMm:30,showTax:false,showEan:false,showArticleNumber:false}}),{code:'PRICE_LABEL_FIT'});
});

test('Trusted logos retain aspect ratio in all six reserved positions and never overlap product photo or text',async()=>{
  const photo=await sharp({create:{width:120,height:180,channels:3,background:'#45A269'}}).webp().toBuffer(),logoWidthMm=30,logoHeightMm=12;
  for(const logoPosition of ['top-left','top-center','top-right','bottom-left','bottom-center','bottom-right']){
    const options={logoKitId:'test-kit',logoAssetKey:'main',logoPosition,logoWidthMm,logoHeightMm,showPhoto:true};
    const [page]=await inspect(await createSalesPriceLabelsPdf({items:[article({imageBuffer:photo})],options,logoBuffer:logoSvg}));
    assert.equal(page.images,2);assert.match(page.text,/1\.599,01 €/);assert.match(page.text,/EAN 4547410533644/);
    const [logo,product]=page.imageRects;assert.notEqual(logo.key,product.key);assert.ok(Math.abs(logo.width/logo.height-4)<.001,'Logo must retain its 4:1 aspect ratio');
    assert.ok(logo.width<=logoWidthMm*MM+.01&&logo.height<=logoHeightMm*MM+.01);
    assert.ok(!overlaps(logo,product),'Logo and photo must have distinct reserved areas');
    for(const image of page.imageRects)for(const item of page.items.filter(item=>item.str))assert.ok(!overlaps(image,textRect(item)),`${logoPosition}: image overlaps ${item.str}`);
    const contentX=(10+4)*MM,contentWidth=(90-8)*MM;
    const expectedX=logoPosition.endsWith('left')?contentX:logoPosition.endsWith('right')?contentX+contentWidth-logo.width:contentX+(contentWidth-logo.width)/2;
    assert.ok(Math.abs(logo.x-expectedX)<.02,`${logoPosition}: incorrect horizontal anchor`);
    const price=page.items.find(item=>item.str==='1.599,01 €');assert.ok(logoPosition.startsWith('top')?logo.y>price.transform[5]:logo.y+logo.height<price.transform[5]);
  }
});

test('Logo failures are explicit and self-contained SVG cannot resolve active or external content',async()=>{
  await assert.rejects(createSalesPriceLabelsPdf({items:[article()],options:{logoKitId:'missing'}}),{code:'PRICE_LABEL_LOGO'});
  for(const logoBuffer of [Buffer.from('invalid'),Buffer.alloc(15*1024*1024+1),'path/to/logo.png'])await assert.rejects(createSalesPriceLabelsPdf({items:[article()],logoBuffer}),{code:'PRICE_LABEL_LOGO'});
  for(const content of ['<script>alert(1)</script>','<image href="https://example.test/logo.png"/>','<use href="file:///etc/passwd"/>','<rect style="fill:url(https://example.test/a.svg)"/>','<style>@import "https://example.test/a.css"</style>','<foreignObject/>','<rect onclick="alert(1)"/>','<style>rect{fill:u\\72l(https://example.test/a.svg)}</style>']){
    const svg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40">${content}</svg>`);
    await assert.rejects(createSalesPriceLabelsPdf({items:[article()],logoBuffer:svg}),{code:'PRICE_LABEL_LOGO'});
  }
  await assert.rejects(createSalesPriceLabelsPdf({items:[article()],logoBuffer:Buffer.from('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><text>&x;</text></svg>')}),{code:'PRICE_LABEL_LOGO'});
  for(const options of [{logoWidthMm:100},{logoHeightMm:50},{shape:'circle',labelWidthMm:60,labelHeightMm:60,logoWidthMm:40},{logoHeightMm:40,showPhoto:true}])await assert.rejects(createSalesPriceLabelsPdf({items:[article()],logoBuffer:logoSvg,options}),{code:'PRICE_LABEL_FIT'});
  const hidden=await inspect(await createSalesPriceLabelsPdf({items:[article()],options:{logoWidthMm:100,logoHeightMm:60}}));assert.equal(hidden[0].images,0);
});

test('Promotion color band cannot paint over a full-height top logo, even with zero logo spacing',async()=>{
  const logoBuffer=await sharp({create:{width:100,height:100,channels:3,background:'#1461FF'}}).png().toBuffer();
  const [page]=await inspect(await createSalesPriceLabelsPdf({items:[article()],logoBuffer,options:{design:'promo',color:'#215345',logoPosition:'top-center',logoSpacingMm:0,logoWidthMm:10,logoHeightMm:10}}));
  assert.equal(page.images,1);assert.ok(page.fillRects.some(rect=>rect.color==='#215345'));
  for(const band of page.fillRects.filter(rect=>rect.color==='#215345'))assert.ok(!overlaps(band,page.imageRects[0]),'Promotion band conceals part of the logo');
  for(const item of page.items.filter(item=>item.str))assert.ok(!overlaps(page.imageRects[0],textRect(item)),`Logo overlaps ${item.str}`);
});

test('Branding, long product text, photos and repeated circular labels stay inside each printed label across pages',async()=>{
  const photo=await sharp({create:{width:180,height:120,channels:3,background:'#538D77'}}).png().toBuffer(),items=Array.from({length:5},(_,i)=>article({articleNumber:'000'+(1234+i),description:'Fujifilm X-T50 Systemkamera Gehäuse silber mit erweitertem Lieferumfang und professionellen Funktionen',imageBuffer:photo}));
  const options={labelWidthMm:90,labelHeightMm:75,shape:'circle',copies:2,design:'promo',color:'#215345',headline:'FOTO & VIDEO',footer:'Beratung in unserer Filiale',logoKitId:'brand-kit',logoAssetKey:'secondary',logoPosition:'bottom-center',logoWidthMm:24,logoHeightMm:8,showPhoto:true};
  const buffer=await createSalesPriceLabelsPdf({items,options,logoBuffer:logoSvg}),pages=await inspect(buffer);assert.equal(pages.length,2);
  assert.equal(pages.reduce((sum,page)=>sum+page.images,0),20);assert.equal((pages.map(page=>page.text).join(' ').match(/1\.599,01 €/g)||[]).length,10);
  for(const page of pages){
    const boxes=[...page.imageRects,...page.items.filter(item=>item.str).map(textRect)];
    for(const box of boxes){
      const cx=box.x+box.width/2,cy=page.height-(box.y+box.height/2),column=Math.floor((cx/MM-10)/(90+4)),row=Math.floor((cy/MM-10)/(75+4));
      const centerX=(10+column*(90+4)+45)*MM,centerY=page.height-(10+row*(75+4)+37.5)*MM,radius=37.5*MM;
      for(const [x,y]of [[box.x,box.y],[box.x+box.width,box.y],[box.x,box.y+box.height],[box.x+box.width,box.y+box.height]])assert.ok(Math.hypot(x-centerX,y-centerY)<radius+.03,'Text/image exceeds circular label');
    }
    for(const image of page.imageRects)for(const item of page.items.filter(item=>item.str))assert.ok(!overlaps(image,textRect(item)),`Image overlaps ${item.str}`);
  }
  if(process.env.PRICE_LABELS_PREVIEW_DIR){const fs=require('node:fs'),path=require('node:path');fs.mkdirSync(process.env.PRICE_LABELS_PREVIEW_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.PRICE_LABELS_PREVIEW_DIR,'labels-logo-promo-circle-multiple.pdf'),buffer);
    for(const [design,shape,logoPosition]of [['classic','rounded','top-left'],['minimal','rectangle','bottom-right']])fs.writeFileSync(path.join(process.env.PRICE_LABELS_PREVIEW_DIR,`labels-logo-${design}-${shape}.pdf`),await createSalesPriceLabelsPdf({items:[items[0]],options:{...options,design,shape,logoPosition,copies:1,labelHeightMm:60,footer:'Beratung in unserer Filiale'},logoBuffer:logoSvg}));
  }
});
