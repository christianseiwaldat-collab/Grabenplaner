(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.SalesChartOptions=api;})(typeof window==='object'?window:this,function(){
  'use strict';
  const palettes={garden:['#20856d','#4686d9','#d99b28','#9164bc','#de745b'],ocean:['#2463b5','#24a4ae','#7c69c2','#d29134','#427d6b'],warm:['#d26745','#cf9f29','#8559a8','#328a85','#477bb6']};
  const defaults=()=>({palette:'garden',currentColor:'#20856d',comparisonColor:'#7796c6',backgroundColor:'#ffffff',colorMode:'groups',corners:'rounded',showValues:true,showComparison:true,showPercent:true,showAbsolute:false,showShare:false,showLegend:true,numberFormat:'full',annotations:[]});
  function normalize(input={}){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!Object.hasOwn(defaults(),k)))throw new TypeError('Ungültige Diagrammgestaltung.');
    const value={...defaults(),...input};
    if(!Object.hasOwn(palettes,value.palette)||!['series','groups'].includes(value.colorMode)||!['square','rounded'].includes(value.corners)||!['full','compact'].includes(value.numberFormat)
      ||['currentColor','comparisonColor','backgroundColor'].some(k=>typeof value[k]!=='string'||!/^#[0-9a-f]{6}$/i.test(value[k]))
      ||['showValues','showComparison','showPercent','showAbsolute','showShare','showLegend'].some(k=>typeof value[k]!=='boolean')
      ||!Array.isArray(value.annotations)||value.annotations.length>3||new Set(value.annotations).size!==value.annotations.length
      ||value.annotations.some(id=>!['netRevenue','grossRevenue','grossMargin','quantity','receiptCount','revenuePerReceipt','marginRate'].includes(id)))throw new TypeError('Ungültige Diagrammgestaltung.');
    return {...value,annotations:[...value.annotations]};
  }
  function color(value,index=0){const design=normalize(value);return design.colorMode==='series'||index===0?design.currentColor:palettes[design.palette][index%palettes[design.palette].length];}
  function dark(value){const c=normalize(value).backgroundColor;return .299*parseInt(c.slice(1,3),16)+.587*parseInt(c.slice(3,5),16)+.114*parseInt(c.slice(5,7),16)<140;}
  const ink=value=>dark(value)?'#f1f7f4':'#203b34',muted=value=>dark(value)?'#cad8d1':'#64786f';
  function formatted(value,unit,design){if(value==null)return '–';const n=Number(value);if(!Number.isFinite(n))return '–';return new Intl.NumberFormat('de-AT',{notation:design?.numberFormat==='compact'?'compact':'standard',minimumFractionDigits:['EUR','%'].includes(unit)?2:0,maximumFractionDigits:['EUR','%'].includes(unit)?2:unit==='quantity'?3:0}).format(n)+(unit==='EUR'?' €':unit==='%'?' %':'');}
  return Object.freeze({palettes,defaults,normalize,color,formatted,ink,muted});
});
