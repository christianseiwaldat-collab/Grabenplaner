'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const Grid = require('../public/sales-price-label-layout'), Editor = require('../public/sales-price-labels'), Pdf = require('../lib/sales-price-labels-pdf');
const options = extra => Editor.normalizeOptions({...Editor.defaults,...extra,...(extra && Object.hasOwn(extra,'showBorder') && !Object.hasOwn(extra,'borderMode') ? {borderMode:'manual'} : {})});
const near = (actual,expected) => assert.ok(Math.abs(actual-expected)<1e-7,`${actual} differs from ${expected}`);

test('Shared physical slots preserve row-major copies and a partly occupied follow page',()=>{
  const value=options({gapMm:4,copies:3}),grid=Grid.create(value,3);
  assert.equal(grid.columns,2);assert.equal(grid.rows,4);assert.equal(grid.labelCount,9);assert.equal(grid.pageCount,2);
  assert.deepEqual(grid.slot(8),{index:8,page:1,position:0,column:0,row:0,x:10,y:10,width:90,height:60,occupied:true,itemIndex:2,copyIndex:2});
  assert.equal(grid.slot(3).itemIndex,1);assert.equal(grid.slot(3).copyIndex,0);
  assert.equal(grid.slot(3).x,104);assert.equal(grid.slot(3).y,74);
  assert.equal(grid.page(1).filter(cell=>cell.occupied).length,1);assert.equal(grid.page(1).length,8);
  assert.deepEqual(grid.page(2),[]);assert.equal(grid.slot(-1),null);
});

test('Decimal edge fit and independent shield/paper orientations use exactly one grid',()=>{
  const value=options({paper:'custom',paperWidthMm:101.6,paperHeightMm:101.6,labelWidthMm:33.1,labelHeightMm:49.3,marginMm:0,gapMm:1.15});
  const grid=Grid.create(value,1);assert.equal(grid.columns,3);assert.equal(grid.rows,2);
  near(grid.slot(2).x+grid.slot(2).width,101.6);
  assert.equal(Editor.paperLayout(value).capacity,grid.capacity);
  assert.deepEqual(Pdf.normalizeOptions(value),{...value,color:value.color.toUpperCase()});
  for(const paper of ['A4','A5'])for(const orientation of ['portrait','landscape']){
    const base=paper==='A4'?[210,297]:[148,210],w=orientation==='portrait'?base[0]:base[1],h=orientation==='portrait'?base[1]:base[0];
    const same=options({paper,orientation,labelWidthMm:w,labelHeightMm:h,marginMm:0});assert.equal(Grid.create(same,1).capacity,1);
    assert.equal(Editor.paperLayout({...same,marginMm:1}).capacity,0);assert.throws(()=>Pdf.normalizeOptions({...same,marginMm:1}),{code:'PRICE_LABEL_FIT'});
  }
});

test('Shared limits count actual copied labels, cap follow pages, and retain empty layout slots',()=>{
  assert.equal(Grid.create(options({copies:50}),20).exceedsLimits,false);
  assert.equal(Grid.create(options({copies:50}),21).exceedsLimits,true);
  const single=options({paper:'custom',paperWidthMm:100,paperHeightMm:70,orientation:'landscape',marginMm:5,gapMm:0});
  assert.equal(Grid.create(single,200).exceedsLimits,false);assert.equal(Grid.create(single,201).exceedsLimits,true);
  const empty=Grid.create(single,0);assert.equal(empty.pageCount,0);assert.equal(empty.page(0).length,1);assert.equal(empty.page(0)[0].occupied,false);
});

test('Every shape guide including a rectangular circle slot stays wholly within the slot at zero paper margin',()=>{
  for(const shape of ['rectangle','rounded','circle']){
    const b=Grid.shapeBounds(shape,0,0,210,297,Grid.CUT_WIDTH_MM),half=Grid.CUT_WIDTH_MM/2;
    assert.ok(b.x-half>=-1e-8);assert.ok(b.y-half>=-1e-8);assert.ok(b.x+b.width+half<=210+1e-8);assert.ok(b.y+b.height+half<=297+1e-8);
    if(shape==='circle'){near(b.width,210-Grid.CUT_WIDTH_MM);near(b.x+b.radius,105);near(b.y+b.radius,148.5);}
  }
});

test('Legacy design borders, strict bools and inactive stored cut marks agree on both sides',()=>{
  for(const normalize of [Editor.normalizeOptions,Pdf.normalizeOptions]){
    for(const design of ['classic','promo','minimal'])assert.equal(normalize({design}).showBorder,design!=='minimal');
    for(const key of ['showBorder','cutMarks'])for(const value of ['true',1,null,[]])assert.throws(()=>normalize({[key]:value}));
    for(const value of [null,true,'auto',''])assert.throws(()=>normalize({borderMode:value}));
    assert.equal(normalize({design:'classic',showBorder:true}).borderMode,'manual');
    assert.equal(normalize({design:'minimal',showBorder:true,borderMode:'design'}).showBorder,false);
    assert.equal(normalize({design:'minimal',showBorder:true,borderMode:'manual'}).showBorder,true);
    const saved=normalize({design:'minimal',showBorder:true,cutMarks:true});assert.equal(saved.showBorder,true);assert.equal(saved.cutMarks,true);assert.equal(Grid.cutsVisible(saved),false);
    assert.equal(Grid.cutsVisible(normalize({showBorder:false,cutMarks:true})),true);
  }
});

test('Paper SVG previews only the selected physical page with layout numbers and escaped slot descriptions',()=>{
  const value=options({copies:3,gapMm:4,showBorder:false,cutMarks:true,shape:'circle'}),grid=Grid.create(value,3);
  const markup=Editor.pagePreview(value,grid,1,[{articleNumber:'one'},{articleNumber:'two'},{articleNumber:'<unsafe>'}]);
  assert.equal((markup.match(/data-pl-slot=/g)||[]).length,8);assert.equal((markup.match(/data-pl-occupied="true"/g)||[]).length,1);
  assert.match(markup,/Schild 9, Artikel &lt;unsafe&gt;, Kopie 3 von 3/);assert.match(markup,/Seite 2 von 2/);
  assert.match(markup,/<circle/);assert.match(markup,/stroke-dasharray="2 1"/);assert.doesNotMatch(markup,/Preis|fontId|logo|<image/);
});
