'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
function extract(name){
  const start=source.indexOf('function '+name+'('),end=source.indexOf('\n}',start)+2;
  assert.ok(start>=0&&end>start,name);return source.slice(start,end);
}
const sandbox={escapeHtml:value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')};
vm.createContext(sandbox);
vm.runInContext(extract('normalizeScheduleNoteSize')+'\n'+extract('scheduleNoteInitialHtml'),sandbox);

test('schedule note point sizes retain exact tenths and reject unsafe or unsupported values',()=>{
  for(const [value,expected] of [[4,'4'],['4.0','4'],['4.1','4.1'],['12,5','12.5'],['12.5pt','12.5'],[72,'72']])
    assert.equal(sandbox.normalizeScheduleNoteSize(value),expected);
  for(const value of [undefined,null,'',false,-1,3.9,72.1,12.55,NaN,Infinity,'1e1','calc(10pt)','10px','12pt;color:red','" onmouseover="x','<script>'])
    assert.equal(sandbox.normalizeScheduleNoteSize(value),null,String(value));
});

test('legacy note flags without HTML become escaped individually editable point markup',()=>{
  assert.equal(sandbox.scheduleNoteInitialHtml({note_text:'Alt & <sicher>\nZeile',font_size:'large',bold:true,italic:true,underline:true}),
    '<span data-size="7.2"><u><i><b>Alt &amp; &lt;sicher&gt;<br>Zeile</b></i></u></span>');
  assert.equal(sandbox.scheduleNoteInitialHtml({note_text:'Alt',font_size:'medium'}),'<span data-size="6.4">Alt</span>');
  assert.equal(sandbox.scheduleNoteInitialHtml({note_text:'Alt',font_size:'small'}),'<span data-size="5.7">Alt</span>');
  assert.equal(sandbox.scheduleNoteInitialHtml({}), '');
  assert.equal(sandbox.scheduleNoteInitialHtml({note_text:'Neu'}), 'Neu');
  assert.equal(sandbox.scheduleNoteInitialHtml({note_text:'Fallback',note_html:'<b>Vorhanden</b>',font_size:'large'}),'<b>Vorhanden</b>');
});

test('point-format preview styles are same-origin and include exact PDF boundary and mixed-selection sizes',()=>{
  const css=fs.readFileSync(path.join(__dirname,'../public/schedule-note-editor.css'),'utf8');
  const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
  assert.match(html,/<link rel="stylesheet" href="\/schedule-note-editor\.css"/);
  for(const rule of ['.ql-size-4pt { font-size:4pt; }','.ql-size-12_5pt { font-size:12.5pt; }','.ql-size-72pt { font-size:72pt; }'])
    assert.ok(css.includes(rule),rule);
  assert.doesNotMatch(css,/\.ql-size-(?:3_9|72_1)pt\b/);
  assert.equal((css.match(/\.ql-size-/g)||[]).length,681);
});
