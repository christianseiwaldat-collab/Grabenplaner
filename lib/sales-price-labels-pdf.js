'use strict';
const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const path = require('node:path');
const crypto = require('node:crypto');
const Fonts = require('../public/sales-price-label-fonts');
const PaperGrid = require('../public/sales-price-label-layout');
const {MAX_LABELS, MAX_PAGES} = PaperGrid;
const MM = 72 / 25.4, MAX_BYTES = 32 * 1024 * 1024, MAX_LOGO_BYTES = 15 * 1024 * 1024;
const KEYS = ['paper','paperWidthMm','paperHeightMm','orientation','labelWidthMm','labelHeightMm','marginMm','gapMm','copies','design','shape','color','showArticleNumber','showEan','showTax','showPhoto','headline','footer','logoKitId','logoAssetKey','logoPosition','logoWidthMm','logoHeightMm','logoSpacingMm','logoMode','logoXmm','logoYmm','fontId','showBorder','cutMarks','borderMode'];
class SalesPriceLabelsPdfError extends Error {
  constructor(message,code='PRICE_LABEL_OPTIONS',status=400){super(message);this.name='SalesPriceLabelsPdfError';this.code=code;this.status=status;}
}
const fail = (message,code,status) => {throw new SalesPriceLabelsPdfError(message,code,status);};
const plain = value => value && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));
const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/[\u2010-\u2015]/g,'-').replace(/\s+/g,' ').trim();
function number(value,fallback,min,max,label){
  const result=value===undefined?fallback:value;
  if(typeof result!=='number'||!Number.isFinite(result)||result<min||result>max)fail(`${label} muss zwischen ${min} und ${max} liegen.`);
  return result;
}
function choice(value,fallback,allowed,label){const result=value===undefined?fallback:value;if(!allowed.includes(result))fail(`${label} ist ungültig.`);return result;}
function text(value,max,label){if(value===undefined)return '';if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))fail(`${label} ist ungültig.`);return clean(value);}
function layout(options){
  const grid=PaperGrid.create(options);
  if(!grid.capacity)fail('Das Preisschild passt mit diesen Maßen und Rändern nicht auf das Papier.','PRICE_LABEL_FIT');
  return grid;
}
function normalizeOptions(value={}){
  if(!plain(value)||Object.keys(value).some(key=>!KEYS.includes(key)))fail('Die Preisschild-Einstellungen sind ungültig.');
  const paper=choice(value.paper,'A4',['A4','A5','A6','custom'],'Papierformat');
  const logoMode=choice(value.logoMode,'reserved',['reserved','free'],'Logoanordnung');
  const options={paper,paperWidthMm:number(value.paperWidthMm,210,10,500,'Papierbreite'),paperHeightMm:number(value.paperHeightMm,297,10,500,'Papierhöhe'),
    orientation:choice(value.orientation,'portrait',['portrait','landscape'],'Ausrichtung'),
    labelWidthMm:number(value.labelWidthMm,90,10,500,'Schildbreite'),labelHeightMm:number(value.labelHeightMm,60,10,500,'Schildhöhe'),
    marginMm:number(value.marginMm,10,0,50,'Rand'),gapMm:number(value.gapMm,4,0,50,'Abstand'),copies:number(value.copies,1,1,50,'Kopien'),
    design:choice(value.design,'classic',['classic','minimal','promo'],'Design'),shape:choice(value.shape,'rectangle',['rectangle','rounded','circle'],'Form'),
    color:value.color===undefined?'#215345':value.color,headline:text(value.headline,70,'Überschrift'),footer:text(value.footer,160,'Fußtext'),
    logoKitId:text(value.logoKitId,120,'Logo-Vorlage'),logoAssetKey:text(value.logoAssetKey,160,'Logo-Auswahl'),
    logoPosition:choice(value.logoPosition,'top-left',['top-left','top-center','top-right','bottom-left','bottom-center','bottom-right'],'Logo-Position'),
    logoWidthMm:number(value.logoWidthMm,20,5,logoMode==='free'?500:100,'Logo-Breite'),logoHeightMm:number(value.logoHeightMm,10,5,logoMode==='free'?500:60,'Logo-Höhe'),
    logoSpacingMm:number(value.logoSpacingMm,2,0,10,'Logo-Abstand'),
    logoMode,
    logoXmm:number(value.logoXmm,4,0,500,'Logo-Position X'),logoYmm:number(value.logoYmm,4,0,500,'Logo-Position Y'),
    fontId:choice(value.fontId,Fonts.defaultId,Fonts.families.map(font=>font.id),'Schriftart')};
  if(options.logoMode==='free'&&(options.logoXmm+options.logoWidthMm>options.labelWidthMm+.001||options.logoYmm+options.logoHeightMm>options.labelHeightMm+.001))fail('Das Logo muss innerhalb der Schildfläche liegen. Bitte Position oder Größe anpassen.');
  if(!Number.isInteger(options.copies)||typeof options.color!=='string'||!/^#[0-9a-f]{6}$/i.test(options.color))fail('Kopienzahl oder Farbe ist ungültig.');
  options.color=options.color.toUpperCase();
  for(const key of ['showArticleNumber','showEan','showTax','showPhoto']){
    if(value[key]!==undefined&&typeof value[key]!=='boolean')fail('Die Anzeigeauswahl ist ungültig.');
    options[key]=value[key]===undefined?key!=='showPhoto':value[key];
  }
  for(const key of ['showBorder','cutMarks']){
    if(value[key]!==undefined&&typeof value[key]!=='boolean')fail('Die Umrandungs- und Schnittmarkenauswahl ist ungültig.');
    options[key]=value[key]===undefined?key==='showBorder'&&options.design!=='minimal':value[key];
  }
  options.borderMode=choice(value.borderMode,value.showBorder===undefined?'design':'manual',['design','manual'],'Umrandungsauswahl');
  if(options.borderMode==='design')options.showBorder=options.design!=='minimal';
  layout(options);return Object.freeze(options);
}
function money(value){
  if(typeof value!=='string')return null;
  const match=/^(\d{1,30})(?:\.(\d{1,324}))?$/.exec(value);if(!match)return null;
  const decimals=match[2]||'',divisor=10n**BigInt(decimals.length),scaled=BigInt(match[1]+decimals)*100n;
  const cents=scaled/divisor+(scaled%divisor*2n>=divisor?1n:0n),digits=cents.toString().padStart(3,'0');
  return digits.slice(0,-2).replace(/\B(?=(\d{3})+(?!\d))/g,'.')+','+digits.slice(-2)+' €';
}
function taxText(value){
  if(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100)value=String(value);
  if(typeof value!=='string'||!/^\d{1,3}(?:\.\d{1,6})?$/.test(value)||Number(value)>100)return 'MwSt. prüfen';
  return 'inkl. '+(value.includes('.')?value.replace(/0+$/,'').replace(/\.$/,''):value).replace('.',',')+' % MwSt.';
}
function contrast(color){
  const parts=[1,3,5].map(index=>parseInt(color.slice(index,index+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
  return parts[0]*.2126+parts[1]*.7152+parts[2]*.0722>.179?'#12221C':'#FFFFFF';
}
function normalizeItems(items){
  if(!Array.isArray(items)||!items.length||items.length>MAX_LABELS)fail('Bitte mindestens einen Artikel und höchstens 1000 Schilder auswählen.','PRICE_LABEL_INPUT');
  return items.map(item=>{
    if(!plain(item)||typeof item.articleNumber!=='string'||!item.articleNumber.trim()||item.articleNumber.length>80)fail('Eine Artikelnummer fehlt oder ist ungültig.','PRICE_LABEL_INPUT');
    for(const [key,max]of [['description',300],['brand',160],['ean',160]])if(item[key]!=null&&(typeof item[key]!=='string'||item[key].length>max))fail('Ein Artikeltext ist ungültig.','PRICE_LABEL_INPUT');
    return {articleNumber:clean(item.articleNumber),description:clean(item.description),brand:clean(item.brand),ean:clean(item.ean),
      price:money(item.priceGross)||'Preis prüfen',tax:taxText(item.taxRate),imageBuffer:item.imageBuffer};
  });
}
async function prepareLogo(buffer){
  if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>MAX_LOGO_BYTES)fail('Das ausgewählte Logo ist ungültig oder größer als 15 MB.','PRICE_LABEL_LOGO');
  const source=buffer.toString('utf8');
  // Apply the same self-contained SVG contract as the existing product PDFs.
  // SVG must not resolve files, remote images, scripts or external styles.
  if((buffer[0]===0xff&&buffer[1]===0xfe)||(buffer[0]===0xfe&&buffer[1]===0xff))fail('Das ausgewählte Logo benötigt ein UTF-8-SVG oder ein Bildformat.','PRICE_LABEL_LOGO');
  if(/<svg\b/i.test(source)){
    const unsafeReference=[...source.matchAll(/(?:href|xlink:href)\s*=\s*(["'])(.*?)\1/gis)].some(match=>!match[2].trim().startsWith('#'));
    const unsafeCssUrl=[...source.matchAll(/url\s*\((.*?)\)/gis)].some(match=>!match[1].trim().replace(/^(["'])(.*)\1$/s,'$2').startsWith('#'));
    if(source.includes('\u0000')||/<!doctype|<!entity|<(?:[A-Za-z_][\w.-]*:)?(?:script|foreignObject|image|iframe)\b|\bon[a-z]+\s*=|@import\b|\\/i.test(source)||unsafeReference||unsafeCssUrl)fail('Das Logo muss eine eigenständige SVG ohne externe Inhalte sein.','PRICE_LABEL_LOGO');
  }
  try{
    const input=sharp(buffer,{failOn:'warning',limitInputPixels:40_000_000}),metadata=await input.metadata();
    if(!['svg','png','jpeg','webp'].includes(metadata.format)||(metadata.format==='svg'&&!/<svg\b/i.test(source)))fail('Das Logo benötigt SVG, PNG, JPEG oder WebP.','PRICE_LABEL_LOGO');
    return await input.rotate().resize({width:1200,height:720,fit:'inside',withoutEnlargement:true}).png({compressionLevel:9,adaptiveFiltering:true}).toBuffer();
  }catch(error){if(error instanceof SalesPriceLabelsPdfError)throw error;fail('Das ausgewählte Logo konnte nicht in das Preisschild übernommen werden.','PRICE_LABEL_LOGO');}
}
async function createSalesPriceLabelsPdf({items,options:value,logoBuffer}={}){
  const options=normalizeOptions(value),articles=normalizeItems(items),grid=PaperGrid.create(options,articles.length),count=grid.labelCount;
  if(grid.exceedsLimits)fail('Der Export darf höchstens 1000 Schilder und 200 Seiten enthalten.','PRICE_LABEL_LIMIT',413);
  if(options.logoKitId&&!logoBuffer)fail('Das ausgewählte Logo ist nicht verfügbar. Bitte die Logo-Auswahl prüfen.','PRICE_LABEL_LOGO');
  const logo=logoBuffer==null?null:await prepareLogo(logoBuffer),images=new Map();
  if(options.showPhoto)for(const item of articles)if(item.imageBuffer!=null){
    if(!Buffer.isBuffer(item.imageBuffer)||!item.imageBuffer.length||item.imageBuffer.length>50*1024)fail('Ein Artikelfoto ist ungültig oder größer als 50 KB.','PRICE_LABEL_IMAGE');
    item.imageKey=crypto.createHash('sha256').update(item.imageBuffer).digest('hex');
    if(!images.has(item.imageKey)){
      try{images.set(item.imageKey,await sharp(item.imageBuffer,{limitInputPixels:1280*1280}).rotate().resize({width:400,height:400,fit:'inside',withoutEnlargement:true}).flatten({background:'#FFFFFF'}).jpeg({quality:85}).toBuffer());}
      catch{fail('Ein Artikelfoto konnte nicht in das Preisschild übernommen werden.','PRICE_LABEL_IMAGE');}
    }
  }
  return new Promise((resolve,reject)=>{
    const doc=new PDFDocument({size:[grid.pageWidthMm*MM,grid.pageHeightMm*MM],margin:0,autoFirstPage:false,
      info:{Title:'Preisschilder',Author:'Grabenplaner',Subject:'Artikel und aktuelle Brutto-Verkaufspreise'}});
    const chosenFont=Fonts.get(options.fontId);
    doc.registerFont('LabelRegular',path.join(__dirname,'../public',chosenFont.regular.slice(1)));
    doc.registerFont('LabelBold',path.join(__dirname,'../public',chosenFont.bold.slice(1)));
    const chunks=[];let bytes=0;doc.on('data',chunk=>{bytes+=chunk.length;if(bytes>MAX_BYTES)doc.destroy(new SalesPriceLabelsPdfError('Die Preisschild-PDF ist zu groß.','PRICE_LABEL_LIMIT',413));else chunks.push(chunk);});
    doc.on('error',reject);doc.on('end',()=>resolve(Buffer.concat(chunks)));
    const openedImages=new Map();let openedLogo;
    function font(size,bold=false,color='#12221C'){doc.font(bold?'LabelBold':'LabelRegular').fontSize(size).fillColor(color);}
    function wrapped(value,width,size,bold=false){
      font(size,bold);const lines=[];let line='';
      for(const word of value.split(/ +/)){
        if(!word)continue;const candidate=line?line+' '+word:word;
        if(doc.widthOfString(candidate)<=width){line=candidate;continue;}
        if(line){lines.push(line);line='';}
        for(const character of word){if(line&&doc.widthOfString(line+character)>width){lines.push(line);line='';}line+=character;}
      }
      if(line)lines.push(line);return lines;
    }
    function fitted(value,width,height,{max=12,min=6,bold=false,truncate=false}={}){
      for(let size=max;size>=min-.001;size-=.25){const lines=wrapped(value,width,size,bold),lineHeight=size*1.22;
        if(lines.length*lineHeight<=height&&lines.every(line=>doc.widthOfString(line)<=width+.001))return {size,lines,lineHeight};
      }
      if(truncate){const size=min,lineHeight=size*1.22,maxLines=Math.floor(height/lineHeight);if(maxLines>=1){const lines=wrapped(value,width,size,bold).slice(0,maxLines);let last=lines.at(-1);while(last&&doc.widthOfString(last+'...')>width)last=last.slice(0,-1);lines[lines.length-1]=last+'...';return {size,lines,lineHeight};}}
      fail('Ein Preisschild ist zu klein für Preis und ausgewählte Angaben. Bitte das Schild vergrößern oder Angaben ausblenden.','PRICE_LABEL_FIT');
    }
    function block(value,x,y,width,height,settings={}){
      if(!value)return;const result=fitted(value,width,height,settings);font(result.size,settings.bold,settings.color||'#12221C');
      result.lines.forEach((line,index)=>doc.text(line,x,y+index*result.lineHeight,{width,align:settings.align||'left',lineBreak:false}));
    }
    function outline(x,y,w,h,strokeMm=0){
      const bounds=PaperGrid.shapeBounds(options.shape,x/MM,y/MM,w/MM,h/MM,strokeMm);
      if(bounds.kind==='circle')return doc.circle((bounds.x+bounds.radius)*MM,(bounds.y+bounds.radius)*MM,bounds.radius*MM);
      if(bounds.kind==='rounded')return doc.roundedRect(bounds.x*MM,bounds.y*MM,bounds.width*MM,bounds.height*MM,bounds.radius*MM);
      return doc.rect(bounds.x*MM,bounds.y*MM,bounds.width*MM,bounds.height*MM);
    }
    function label(item,x,y,w,h){
      doc.save();outline(x,y,w,h).fill('#FFFFFF');outline(x,y,w,h).clip();
      let ix=x,iy=y,iw=w,ih=h;
      if(options.shape==='circle'){const side=Math.min(w,h)*.69;ix=x+(w-side)/2;iy=y+(h-side)/2;iw=side;ih=side;}
      const pad=Math.min(4*MM,iw*.06,ih*.075);ix+=pad;iy+=pad;iw-=2*pad;ih-=2*pad;
      if(iw<12*MM||ih<15*MM)fail('Das Preisschild ist zu klein für eine lesbare Druckansicht.','PRICE_LABEL_FIT');
      const reservedLogo=Boolean(logo&&options.logoMode==='reserved');
      if(reservedLogo){
        const logoWidth=options.logoWidthMm*MM,logoHeight=options.logoHeightMm*MM,reservedHeight=logoHeight+options.logoSpacingMm*MM;
        if(logoWidth>iw+.001||ih-reservedHeight<15*MM)fail('Das Logo ist für dieses Preisschild zu groß. Bitte das Logo verkleinern, das Schild vergrößern oder Angaben ausblenden.','PRICE_LABEL_FIT');
        const top=options.logoPosition.startsWith('top-'),position=options.logoPosition.split('-')[1];
        const logoX=position==='center'?ix+(iw-logoWidth)/2:position==='right'?ix+iw-logoWidth:ix;
        const logoY=top?iy:iy+ih-logoHeight;
        if(!openedLogo)openedLogo=doc.openImage(logo);
        doc.image(openedLogo,logoX,logoY,{fit:[logoWidth,logoHeight],align:'center',valign:'center'});
        if(top)iy+=reservedHeight;ih-=reservedHeight;
      }
      const headline=options.headline||item.brand,topHeight=ih*.13,descriptionY=iy+topHeight+ih*.025,descriptionHeight=ih*.25;
      if(options.design==='promo'){
        if(reservedLogo&&options.logoPosition.startsWith('top-')){
          const before=Math.min(pad*.5,options.logoSpacingMm*MM);
          doc.rect(x,iy-before,w,topHeight+before+ih*.02).fill(options.color);
        }
        else doc.rect(x,y,w,Math.max(iy+topHeight-y+ih*.02,h*.18)).fill(options.color);
      }
      else if(options.design==='classic')doc.rect(x,y,w,1.2*MM).fill(options.color);
      block(headline,ix,iy,iw,topHeight,{max:Math.min(13,topHeight/1.25),min:6,bold:true,truncate:true,
        color:options.design==='promo'?contrast(options.color):options.color,align:options.design==='minimal'?'center':'left'});
      const imageWidth=item.imageKey?Math.min(iw*.28,descriptionHeight*1.1):0;
      if(imageWidth){if(!openedImages.has(item.imageKey))openedImages.set(item.imageKey,doc.openImage(images.get(item.imageKey)));doc.image(openedImages.get(item.imageKey),ix+iw-imageWidth,descriptionY,{fit:[imageWidth,descriptionHeight],align:'center',valign:'center'});}
      block(item.description,ix,descriptionY,iw-(imageWidth?imageWidth+2*MM:0),descriptionHeight,{max:Math.min(14,ih*.095),min:6,bold:options.design!=='minimal',truncate:true,align:options.design==='minimal'?'center':'left'});
      block(item.price,ix,iy+ih*(reservedLogo ? .43 : .445),iw,ih*(reservedLogo ? .25 : .275),{max:Math.min(85,ih*(reservedLogo ? .20 : .225)),min:12,bold:true,align:'center',color:options.design==='promo'&&contrast(options.color)==='#FFFFFF'?options.color:'#12221C'});
      const details=[...(options.showTax?[item.tax]:[]),...(options.showArticleNumber?['Art. '+item.articleNumber]:[]),...(options.showEan&&item.ean?['EAN '+item.ean]:[]),...(options.footer?[options.footer]:[])];
      if(details.length){const start=iy+ih*(reservedLogo ? .70 : .735),height=ih*(reservedLogo ? .30 : .265)/ details.length;
        details.forEach((detail,index)=>block(detail,ix,start+index*height,iw,height,{max:Math.min(8,height/1.25),min:5,truncate:index===details.length-1&&!!options.footer,align:'center',color:'#44564D'}));}
      if(logo&&options.logoMode==='free'){
        if(!openedLogo)openedLogo=doc.openImage(logo);
        // Free geometry is relative to the full label; paint after text so the
        // explicitly chosen overlay can cover text/price, inside the shape clip.
        doc.image(openedLogo,x+options.logoXmm*MM,y+options.logoYmm*MM,
          {fit:[options.logoWidthMm*MM,options.logoHeightMm*MM],align:'center',valign:'center'});
      }
      doc.restore();
      if(options.showBorder){
        doc.save();outline(x,y,w,h,PaperGrid.BORDER_WIDTH_MM).lineWidth(PaperGrid.BORDER_WIDTH_MM*MM).strokeColor(options.color).stroke();doc.restore();
      }else if(PaperGrid.cutsVisible(options)){
        doc.save();outline(x,y,w,h,PaperGrid.CUT_WIDTH_MM).lineWidth(PaperGrid.CUT_WIDTH_MM*MM).strokeColor('#79877F').dash(2*MM,{space:MM}).stroke();doc.restore();
      }
    }
    try{
      for(let index=0;index<count;index++){
        const slot=grid.slot(index);if(slot.position===0)doc.addPage();
        label(articles[slot.itemIndex],slot.x*MM,slot.y*MM,slot.width*MM,slot.height*MM);
      }
      doc.end();
    }catch(error){doc.destroy();reject(error);}
  });
}
module.exports={createSalesPriceLabelsPdf,normalizeOptions,SalesPriceLabelsPdfError,MAX_LABELS,MAX_PAGES,MM};
