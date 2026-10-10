'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Print=require('../public/gp-print-window');
test('print defaults and orientation normalize without mixing filename and PDF title',()=>{
  assert.deepEqual(Print.normalizeValues(),{title:'PDF-Ausgabe',filename:'Auswertung',orientation:'portrait'});
  assert.deepEqual(Print.normalizeValues({title:'Artikel 42',name:'Artikel-42',orientation:'landscape'}),{title:'Artikel 42',filename:'Artikel-42',orientation:'landscape'});
  assert.deepEqual(Print.normalizeValues({title:'',filename:'',orientation:'invalid'}),{title:'',filename:'',orientation:'portrait'},'Empty inputs stay invalid, never silently replaced');
  assert.equal(Print.normalizeValues({title:'x'.repeat(500),filename:'y'.repeat(500)}).title.length,120);
  assert.equal(Print.normalizeValues({title:'x'.repeat(500),filename:'y'.repeat(500)}).filename.length,100);
});
test('download names are safe leaf names with exactly one PDF extension',()=>{
  assert.equal(Print.filename('Abverkauf.pdf'),'Abverkauf.pdf');
  assert.equal(Print.filename('C:\\temp/<camera>:?\u0000 .pdf'),'C--temp--camera----.pdf');
  assert.equal(Print.filename(' ... '),'Auswertung.pdf');
  assert.equal(Print.filename('x'.repeat(500)).length,184);
  assert.ok(!/[\\/:*?"<>|\u0000-\u001f]/.test(Print.filename('../Ausgabe')));
});
test('print window fails closed without its browser window and PDF dependencies',()=>{
  assert.throws(()=>Print.mount({}),/benötigt GP-Fenster/);
  assert.throws(()=>Print.mount({document:{defaultView:{GpWindow:{},GpPdfPreview:{}}}}),/Kontoschlüssel/);
});

test('readonly and absent common options never promise unsupported renderer settings',()=>{
 assert.deepEqual(Print.normalizeCommonFields(false),{title:'hidden',filename:'hidden',orientation:'hidden'});
 assert.deepEqual(Print.normalizeCommonFields('readonly'),{title:'readonly',filename:'readonly',orientation:'readonly'});
 assert.deepEqual(Print.normalizeCommonFields({title:'readonly',filename:true,orientation:false}),{title:'readonly',filename:'editable',orientation:'hidden'});
 for(const value of [null,[],{other:true},{title:'ignored'}])assert.throws(()=>Print.normalizeCommonFields(value),/Druckfelder/);
 assert.equal(Print.normalizeValues({filename:'x'.repeat(200)}).filename.length,100,'Editable input remains bounded separately from server filenames');
});
test('leaving a print page aborts work and releases sensitive preview bytes while retaining the input draft',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require.resolve('../public/gp-print-window'),'utf8');
 const clear=source.slice(source.indexOf('    function clear(){'),source.indexOf('    const viewer='));
 const deactivate=source.match(/    function deactivate\(\)\{[^\n]+/)[0];
 const request=new AbortController(),log=[],button={disabled:false},count={textContent:'3 Seiten'};
 const sandbox={request,serial:0,timer:77,pageEnabled:true,ready:true,loading:true,pages:3,signature:'current',previewTicket:1,blob:{private:true},summary:'Plan',downloadUrl:'blob:private',downloadName:'Plan.pdf',
  win:{clearTimeout:()=>log.push('timer cleared'),URL:{revokeObjectURL:url=>log.push(url)}},viewer:{clear:()=>log.push('preview cleared')},controller:{suspend:()=>log.push('suspended')},notify:()=>log.push('notified'),q:selector=>selector.includes('count')?count:button,draft:{title:'My plan',filename:'My file'}};
 vm.createContext(sandbox);vm.runInContext(clear+'\n'+deactivate+'\ndeactivate();',sandbox);
 assert.equal(request.signal.aborted,true);assert.equal(sandbox.blob,null);assert.equal(sandbox.request,null);assert.equal(sandbox.downloadUrl,'');assert.equal(sandbox.ready,false);assert.equal(button.disabled,true);assert.equal(count.textContent,'');
 assert.ok(log.includes('blob:private'));assert.deepEqual(sandbox.draft,{title:'My plan',filename:'My file'});
});

test('inactive source page in an otherwise allowed print workspace also aborts and clears bytes without removing choices',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require.resolve('../public/gp-print-window'),'utf8');
 const clear=source.slice(source.indexOf('    function clear(){'),source.indexOf('    const viewer=')),begin=source.indexOf('    function sync(){'),end=source.indexOf('    function formSnapshot',begin);
 const request=new AbortController(),log=[],sandbox={request,serial:0,timer:null,ready:true,loading:true,pages:2,signature:'bytes',previewTicket:1,blob:{private:true},summary:'',downloadUrl:'blob:private',downloadName:'Private.pdf',
  config:{key:()=> 'A',canUse:()=>true},actor:'A',usable:()=>false,permitted:()=>true,win:{clearTimeout(){},URL:{revokeObjectURL:url=>log.push(url)}},viewer:{clear:()=>log.push('cleared')},controller:{suspend:()=>log.push('suspended')},q:()=>({}),choices:{filename:'My choice'},notify(){}};
 vm.createContext(sandbox);vm.runInContext(clear+'\n'+source.slice(begin,end)+'\nsync();',sandbox);assert.equal(request.signal.aborted,true);assert.equal(sandbox.blob,null);assert.equal(sandbox.downloadUrl,'');assert.equal(sandbox.pages,0);assert.deepEqual(sandbox.choices,{filename:'My choice'});assert.deepEqual(log,['blob:private','cleared','suspended']);
});
