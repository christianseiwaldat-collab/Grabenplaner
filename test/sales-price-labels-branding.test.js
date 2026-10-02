'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createSalesPriceLabelsBranding}=require('../lib/sales-price-labels-branding');
test('branding selector exposes local logos only, without administrative kit data',async()=>{
  const branding=createSalesPriceLabelsBranding({listKits:()=>[{id:'kit-1',name:'Firma',branding:{logoUrl:'/branding-kits/kit-1/assets/logo.svg',iconUrl:'https://external.invalid/logo.png',adminEmail:'private@example.invalid'}},{id:'neutral',branding:{logoUrl:'/assets/grabenplaner-logo.svg'}}],kitsDirectory:'unused',publicDirectory:'unused'});
  const result=await branding.list();assert.equal(result.kits.length,2);assert.deepEqual(result.kits[0].logos,[{key:'logo',label:'Firmenlogo',url:'/branding-kits/kit-1/assets/logo.svg'}]);assert.equal(JSON.stringify(result).includes('private@example'),false);
});
test('logo buffers come from the installed asset, rejecting deleted assets and client paths',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gp-branding-test-'));
  try{
    const kits=path.join(directory,'kits');await fs.mkdir(path.join(kits,'one','assets'),{recursive:true});await fs.writeFile(path.join(kits,'one','assets','logo.svg'),'<svg/>');
    const branding=createSalesPriceLabelsBranding({listKits:()=>[{id:'one',name:'One',branding:{logoUrl:'/branding-kits/one/assets/logo.svg'}}],kitsDirectory:kits,publicDirectory:directory});
    assert.equal((await branding.content({logoKitId:'one',logoAssetKey:'logo'})).toString(),'<svg/>');
    for(const input of [{logoKitId:'../one',logoAssetKey:'logo'},{logoKitId:'one',logoAssetKey:'../logo.svg'}])await assert.rejects(branding.content(input),e=>e.code==='PRICE_LABEL_LOGO');
    await fs.unlink(path.join(kits,'one','assets','logo.svg'));await assert.rejects(branding.content({logoKitId:'one',logoAssetKey:'logo'}),e=>e.code==='PRICE_LABEL_LOGO');
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
