'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Scanner=require('../public/article-code-scanner');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({pendingCamera=false,denied=false}={}){
  const events=new Map(),pageEvents=new Map(),values=[];let callback,release,requested=0,stopped=0,controlStops=0,active=true;
  const stream={getTracks:()=>[{stop(){stopped++;}}]},controls={stop(){controlStops++;}};
  const dialog={open:false,showModal(){this.open=true;},close(){if(this.open){this.open=false;events.get('close')?.();}},addEventListener:(n,f)=>events.set(n,f),removeEventListener:n=>events.delete(n)};
  const video={srcObject:null,pause(){}},status={textContent:''};
  const environment={document:{hidden:false,addEventListener:(n,f)=>pageEvents.set(n,f),removeEventListener:n=>pageEvents.delete(n)},
    navigator:{mediaDevices:{getUserMedia:async constraints=>{requested++;assert.equal(constraints.audio,false);assert.equal(constraints.video.facingMode.ideal,'environment');if(denied)throw Object.assign(new Error(),{name:'NotAllowedError'});return pendingCamera?new Promise(r=>release=r):stream;}}}};
  const decoder=async()=>({BrowserMultiFormatReader:class{async decodeFromStream(s,v,cb){assert.equal(s,stream);callback=cb;return controls;}}});
  const scanner=Scanner.create({dialog,video,status,environment,decoder,active:()=>active,onValue:v=>values.push(v)});
  return {scanner,dialog,status,environment,values,stream,release:()=>release(stream),result:text=>callback({getText:()=>text},undefined,controls),blank:()=>callback(undefined,{name:'NotFoundException'},controls),hide(){environment.document.hidden=true;pageEvents.get('visibilitychange')();},revoke(){active=false;},get requested(){return requested;},get stopped(){return stopped;},get controlStops(){return controlStops;}};
}
test('EAN, article code and QR product identifiers preserve leading zeros; unrelated QR secrets are not searched',()=>{
  for(const value of ['000042','4006381333931','Sony A6700'])assert.equal(Scanner.searchValue(value),value);
  assert.equal(Scanner.searchValue('https://example.test/01/04006381333931'),'04006381333931');
  assert.equal(Scanner.searchValue('https://example.test/product?ean=0000042'),'0000042');
  for(const value of ['WIFI:T:WPA;S:private;P:secret;;','mailto:private@example.test','javascript:alert(1)','https://example.test/?token=private','<script>','a\u0000b','x'.repeat(161)])assert.equal(Scanner.searchValue(value),null);
});
test('camera starts only after user action, ignores empty frames and stops on the first valid result',async()=>{
  const f=fixture();assert.equal(f.requested,0);await f.scanner.open();assert.equal(f.requested,1);f.blank();assert.equal(f.dialog.open,true);
  f.result('0000042');assert.deepEqual(f.values,['0000042']);assert.equal(f.dialog.open,false);assert.ok(f.stopped);f.result('duplicate');assert.deepEqual(f.values,['0000042']);f.scanner.destroy();
});
test('closing during the permission prompt stops a late camera stream without starting a search',async()=>{
  const f=fixture({pendingCamera:true}),opening=f.scanner.open();await turn();f.scanner.close();f.release();await opening;
  assert.equal(f.stopped,1);assert.deepEqual(f.values,[]);f.scanner.destroy();
});
test('permission rejection stays readable, and hiding the page or revoking access prevents a scan result',async()=>{
  const denied=fixture({denied:true});await denied.scanner.open();assert.match(denied.status.textContent,/nicht erlaubt/);denied.scanner.destroy();
  const f=fixture();await f.scanner.open();f.hide();assert.equal(f.dialog.open,false);assert.ok(f.stopped);f.scanner.destroy();
  const other=fixture();await other.scanner.open();other.revoke();other.result('000042');assert.deepEqual(other.values,[]);other.scanner.destroy();assert.ok(other.stopped);
});
test('the bundled decoder reads a synthetic QR and EAN without camera or network services',()=>{
  const requirePeer=require('node:module').createRequire(require.resolve('@zxing/browser')),z=requirePeer('@zxing/library');
  const qr=new z.QRCodeWriter().encode('000042',z.BarcodeFormat.QR_CODE,180,180,new Map()),pixels=new Uint8ClampedArray(180*180);
  for(let y=0;y<180;y++)for(let x=0;x<180;x++)pixels[y*180+x]=qr.get(x,y)?0:255;
  const vm=require('node:vm'),context={window:{},TextDecoder,TextEncoder,console};
  vm.runInNewContext(require('node:fs').readFileSync(require.resolve('@zxing/browser/umd/zxing-browser.min.js'),'utf8'),context);
  const bundled=context.ZXingBrowser;
  const result=new bundled.BrowserMultiFormatReader().decodeBitmap(new z.BinaryBitmap(new z.HybridBinarizer(new z.RGBLuminanceSource(pixels,180,180))));
  assert.equal(Scanner.searchValue(result.getText()),'000042');
  const blank=new z.BinaryBitmap(new z.HybridBinarizer(new z.RGBLuminanceSource(new Uint8ClampedArray(180*180).fill(255),180,180)));
  assert.throws(()=>new bundled.BrowserMultiFormatReader().decodeBitmap(blank),error=>Scanner.isEmptyFrame(error));
  // EAN-13 4006381333931, including quiet zones; the standard guard/parity
  // pattern is a fixed synthetic fixture independent of the decoder.
  const bits=['00000000000','101','0001101','0100111','0101111','0111101','0001001','0110011','01010','1000010','1000010','1000010','1110100','1000010','1100110','101','00000000000'].join('');
  const row=new z.BitArray(bits.length);for(let i=0;i<bits.length;i++)if(bits[i]==='1')row.set(i);
  assert.equal(new z.EAN13Reader().decodeRow(0,row).getText(),'4006381333931');
  const width=bits.length*3,bars=new Uint8ClampedArray(width*100);
  for(let y=0;y<100;y++)for(let x=0;x<width;x++)bars[y*width+x]=bits[Math.floor(x/3)]==='1'?0:255;
  assert.equal(new bundled.BrowserMultiFormatReader().decodeBitmap(new z.BinaryBitmap(new z.HybridBinarizer(new z.RGBLuminanceSource(bars,width,100)))).getText(),'4006381333931');
});
