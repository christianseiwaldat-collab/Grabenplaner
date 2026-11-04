(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.SalesArticleSheetOptions=api;})(typeof window==='object'?window:this,function(){
  'use strict';
  const groups=[['master','Artikelangaben'],['supplier','Lieferant & Bestellung'],['stock','Bestandsangaben'],['flags','Kennzeichen'],['description','Beschreibung & Lieferumfang'],['links','Produktlinks']];
  const defaults=()=>({sections:['master'],includeImage:false,masterGroups:groups.map(([id])=>id),includeStock:true,priceParts:['sales','purchase','margin','future'],showSalesPrices:true,showSalesMargin:true,layout:'standard',accentColor:'#245448',orientation:'portrait'});
  const uiDefaults=()=>({...defaults(),priceParts:[],showSalesPrices:false,showSalesMargin:false});
  const fields=Object.keys(defaults());
  function normalize(input={}){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!fields.includes(k)))throw new TypeError('Ungültige Auswahl für das Artikelstammblatt.');
    const d={...defaults(),...input},selection=(v,ids,min=0)=>Array.isArray(v)&&v.length>=min&&v.length<=ids.length&&new Set(v).size===v.length&&v.every(id=>ids.includes(id));
    if(!selection(d.sections,['master','prices','notes','identifiers','movements','sales'],1)||!selection(d.masterGroups,groups.map(([id])=>id))||!selection(d.priceParts,['sales','purchase','margin','future'])
      ||['includeImage','includeStock','showSalesPrices','showSalesMargin'].some(k=>typeof d[k]!=='boolean')||!['portrait','landscape'].includes(d.orientation)||!['standard','compact','editorial'].includes(d.layout)||typeof d.accentColor!=='string'||!/^#[a-f0-9]{6}$/i.test(d.accentColor))throw new TypeError('Ungültige Auswahl für das Artikelstammblatt.');
    return {...d,sections:[...d.sections],masterGroups:[...d.masterGroups],priceParts:[...d.priceParts]};
  }
  function read(host){return normalize({sections:[...host.querySelectorAll('[name=section]:checked:not(:disabled)')].map(e=>e.value),includeImage:host.querySelector('[name=image]').checked,
    masterGroups:[...host.querySelectorAll('[name=masterGroup]:checked')].map(e=>e.value),includeStock:host.querySelector('[name=includeStock]').checked,
    priceParts:[...host.querySelectorAll('[name=pricePart]:checked:not(:disabled)')].map(e=>e.value),showSalesPrices:host.querySelector('[name=showSalesPrices]').checked,showSalesMargin:host.querySelector('[name=showSalesMargin]').checked,
    layout:host.querySelector('[name=sheetLayout]').value,accentColor:host.querySelector('[name=sheetAccent]').value,orientation:host.closest('form').elements.orientation.value});}
  function decorate(host,input,article){
    const value=normalize(input),doc=host.ownerDocument;
    for(const check of host.querySelectorAll('[name=section]'))check.checked=value.sections.includes(check.value)&&!check.disabled;
    host.querySelector('[name=image]').checked=value.includeImage&&article.image?.present===true;
    const panel=doc.createElement('div');panel.className='article-sheet-design-controls';
    panel.innerHTML='<div class="article-sheet-presets"><button type="button" data-sheet-preset="master">Nur Artikelstamm</button><button type="button" data-sheet-preset="sales">Mit VK-Preisen</button><button type="button" data-sheet-preset="all">Interner Bericht</button></div><fieldset><legend>Preise gezielt mitgeben</legend><div class="article-sheet-design-checks">'+[['sales','VK-Preise'],['purchase','EK-Preise'],['margin','Rohertrag / RE'],['future','Zukunftspreise']].map(([id,label])=>'<label><input type="checkbox" name="pricePart" value="'+id+'">'+label+'</label>').join('')+'</div><label><input type="checkbox" name="showSalesPrices">Preisdetails der Verkäufe mitgeben</label><small data-sheet-price-hint></small></fieldset><details><summary>Stammdaten-Felder auswählen</summary><div class="article-sheet-design-checks">'+groups.map(([id,label])=>'<label><input type="checkbox" name="masterGroup" value="'+id+'">'+label+'</label>').join('')+'</div><label><input type="checkbox" name="includeStock">Filialbestand als Tabelle</label></details><fieldset><legend>Layout</legend><label>Gestaltung<select name="sheetLayout"><option value="standard">Klassisch · ruhige Tabellen</option><option value="compact">Kompakt · mehr Inhalt je Seite</option><option value="editorial">Editorial · farbige Tabellenköpfe</option></select></label><label>Akzentfarbe<input type="color" name="sheetAccent"></label></fieldset>';
    host.insertBefore(panel,host.querySelector('details'));host.querySelector('.article-sheet-sections').before(panel.querySelector('.article-sheet-presets'));
    for(const input of panel.querySelectorAll('[name=pricePart]')){input.checked=value.priceParts.includes(input.value);if(['purchase','margin'].includes(input.value)&&!article.priceMatrix?.costsRead){input.checked=false;input.disabled=true;}}
    for(const input of panel.querySelectorAll('[name=masterGroup]'))input.checked=value.masterGroups.includes(input.value);
    const marginLabel=doc.createElement('label');marginLabel.innerHTML='<input type="checkbox" name="showSalesMargin">RE der Verkäufe mitgeben';panel.querySelector('[name=showSalesPrices]').closest('label').after(marginLabel);
    panel.querySelector('[name=includeStock]').checked=value.includeStock;panel.querySelector('[name=showSalesPrices]').checked=value.showSalesPrices;panel.querySelector('[name=showSalesMargin]').checked=value.showSalesMargin;
    panel.querySelector('[name=sheetLayout]').value=value.layout;panel.querySelector('[name=sheetAccent]').value=value.accentColor;
    for(const check of panel.querySelectorAll('[name=pricePart]'))if(check.disabled)check.dataset.restricted='true';
    const sync=e=>{const prices=host.querySelector('[name=section][value=prices]').checked;
      if(e?.target?.matches('[name=section][value=prices]')&&prices&&!panel.querySelector('[name=pricePart]:checked'))panel.querySelector('[name=pricePart][value=sales]').checked=true;
      for(const check of panel.querySelectorAll('[name=pricePart]'))check.disabled=!prices||check.dataset.restricted==='true';
      panel.querySelector('[name=showSalesPrices]').disabled=!host.querySelector('[name=section][value=sales]').checked;
      panel.querySelector('[name=showSalesMargin]').disabled=panel.querySelector('[name=showSalesPrices]').disabled||!panel.querySelector('[name=showSalesPrices]').checked;
      panel.querySelector('[data-sheet-price-hint]').textContent=prices?'Nur die angehakten Preisbereiche erscheinen im PDF.':'Preise sind ausgeschaltet. Das PDF enthält keinen Preisbereich.';};
    const preset=e=>{const button=e.target.closest('[data-sheet-preset]');if(!button)return;const kind=button.dataset.sheetPreset;
      for(const check of host.querySelectorAll('[name=section]'))check.checked=!check.disabled&&(check.value==='master'||kind!=='master'&&check.value==='prices'||kind==='all'&&check.value==='notes');
      for(const check of panel.querySelectorAll('[name=pricePart]'))if(check.dataset.restricted!=='true')check.checked=kind==='all'||kind==='sales'&&check.value==='sales';
      panel.querySelector('[name=showSalesPrices]').checked=kind==='all';panel.querySelector('[name=showSalesMargin]').checked=kind==='all';sync();host.dispatchEvent(new doc.defaultView.Event('change',{bubbles:true}));};
    const hint=host.querySelector('p.gp-print-hint');if(hint){const info=doc.createElement('details'),summary=doc.createElement('summary');summary.textContent='Historien und Datenstand';hint.before(info);info.append(summary,hint);}
    host.addEventListener('click',preset);host.addEventListener('change',sync);sync();return ()=>{host.removeEventListener('click',preset);host.removeEventListener('change',sync);};
  }
  return Object.freeze({groups,fields,defaults,uiDefaults,normalize,read,decorate});
});
