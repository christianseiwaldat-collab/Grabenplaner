'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const layout = require('../public/table-layout');
const articleLayout = require('../public/sales-article-column-widths');

function fixture({zoom = 1, article = false} = {}) {
  const attr = article ? 'data-sales-article-column-resize' : 'data-gp-column-resize';
  const columns = [{id:'articleNumber',width:140},{id:'description',width:340},{id:'actions',width:190,resizable:false}];
  const listeners = new Map(), classes = new Set();
  const handles = columns.filter(c => c.resizable !== false).map(c => ({
    id:c.id, attrs:{[attr]:c.id}, classList:{add(){}}, capture:null,
    getAttribute(name){return this.attrs[name];}, setAttribute(name,value){this.attrs[name]=value;},
    closest(selector){return selector === '[' + attr + ']' ? this : null;}, focus(){},
    setPointerCapture(id){this.capture=id;}, hasPointerCapture(id){return this.capture===id;}, releasePointerCapture(){this.capture=null;}
  }));
  const group = {dataset:{},children:[],replaceChildren(...children){this.children=children;}};
  const table = {
    style:{}, parentElement:{clientWidth:670}, classList:{add:c=>classes.add(c),remove:c=>classes.delete(c)},
    querySelector:s=>s==='colgroup'?group:null, querySelectorAll:()=>handles,
    ownerDocument:{createElement:()=>({dataset:{},style:{}})},
    addEventListener(type,listener){listeners.set(type,listener);}, removeEventListener(type){listeners.delete(type);},
    getBoundingClientRect(){return {width:parseFloat(this.style.width)*zoom};},
    tHead:{rows:[{cells:columns.map((c,i)=>({getBoundingClientRect:()=>({width:parseFloat(group.children[i].style.width)*zoom})}))}]}
  };
  let widths = {articleNumber:140,description:340,primaryIdentifier:200}, persisted = 0, enabled = true;
  const options = {columns:()=>columns,allowedColumns:()=>['articleNumber','description','primaryIdentifier'],widths:()=>widths,canResize:()=>enabled,change:next=>{widths=next;},persist:()=>{persisted++;}};
  const mount = () => (article ? articleLayout : layout).attach(table,options);
  function fire(type,extra={}) {
    let prevented=false, stopped=false;
    listeners.get(type)?.({target:handles[0],pointerId:1,button:0,clientX:200,preventDefault(){prevented=true;},stopPropagation(){stopped=true;},...extra});
    return {prevented,stopped};
  }
  return {table,group,handles,classes,mount,fire,disable(){enabled=false;},get widths(){return widths;},get persisted(){return persisted;}};
}

for (const article of [false,true]) {
  const name = article ? 'Article search' : 'Trade and article histories';
  test(name + ': dragging at GP zoom changes only the chosen column in CSS pixels', () => {
    for (const zoom of [1,1.6,2.5]) {
      const f=fixture({zoom,article}), controller=f.mount();
      f.fire('pointerdown'); f.fire('pointermove',{clientX:200+50*zoom});
      assert.deepEqual(f.widths,{articleNumber:190,description:340,primaryIdentifier:200});
      assert.equal(f.handles[0].attrs['aria-valuenow'],'190');
      assert.equal(f.persisted,0,'Do not send a write for every pointer move');
      f.fire('pointerup'); f.fire('lostpointercapture');
      assert.equal(f.persisted,1); assert.equal(f.classes.has('is-resizing-column'),false);
      assert.deepEqual(f.fire('click'),{prevented:true,stopped:true},'A resize must not sort');
      controller.destroy();
    }
  });
  test(name + ': keyboard resizing keeps hidden widths and restores the saved layout', () => {
    const f=fixture({zoom:2.5,article}), first=f.mount();
    f.fire('keydown',{key:'ArrowRight'}); assert.equal(f.widths.articleNumber,150);
    f.fire('keydown',{key:'ArrowLeft',shiftKey:true}); assert.equal(f.widths.articleNumber,110);
    f.fire('keydown',{key:'Home'}); assert.equal(f.widths.articleNumber,80);
    f.fire('keydown',{key:'End'}); assert.equal(f.widths.articleNumber,800);
    assert.equal(f.widths.primaryIdentifier,200); assert.equal(f.widths.description,340);
    assert.equal(f.widths.actions,undefined); assert.equal(f.persisted,4);
    first.destroy(); const second=f.mount();
    assert.equal(f.handles[0].attrs['aria-valuenow'],'800'); assert.equal(f.persisted,4);
    f.disable(); second.render();
    f.fire('pointerdown');f.fire('pointermove',{clientX:10});f.fire('pointerup');f.fire('keydown',{key:'Home'});
    assert.equal(f.widths.articleNumber,800);assert.equal(f.persisted,4);assert.equal(f.handles[0].disabled,true);
    second.destroy();
  });
}
