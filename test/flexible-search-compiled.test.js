'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const Search = require('../lib/flexible-search');
const { matching } = require('../lib/persistence/repositories/sales-article-workspace');

test('Compiled normalized search preserves separators, folding, wildcards, entities and literal characters', () => {
  const values = ['HAMA H-5120', 'Öl Zubehör 12.34', 'Straße / Übergewinde', '100%_literal', 'CANON 4147C004AA'];
  const cases = [
    ['h 5120',[0]], ['öl 12?4',[1]], ['STRASSE &#220;ber',[2]], ['über*gew?nde',[2]],
    ['100%_literal',[3]], ['canon 4147c*',[4]], ['missing',[]], ['', [0,1,2,3,4]],
  ];
  for (const [query, expected] of cases) {
    const matches = Search.compile(query);
    assert.deepEqual(values.flatMap((value,index) => matches(Search.text(value)) ? [index] : []),expected,query);
  }
  assert.throws(() => Search.compile('a b c d e f g h i j k'),RangeError);
});

test('Compiled order matching excludes stale secondary snapshots and preserves unique article ordering', () => {
  const rows = new Map([
    ['a',{articleKey:'1',number:Search.text('H-5120'),secondary:false}],
    ['b',{articleKey:'1',number:Search.text('H-5120'),secondary:true,snapshot:'current'}],
    ['c',{articleKey:'2',number:Search.text('H-5120'),secondary:true,snapshot:'old'}],
    ['d',{articleKey:'3',number:Search.text('H-5120'),secondary:true,snapshot:'current'}],
    ['e',{articleKey:'4',number:'',secondary:false}],
  ]);
  assert.deepEqual(matching(rows,'h 51?0','current'),['1','3']);
  assert.deepEqual(matching(rows,'h 51?0',null),['1']);
  assert.deepEqual(matching(rows,"' OR 1=1 --",'current'),[]);
});
