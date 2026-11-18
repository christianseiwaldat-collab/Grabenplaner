'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Time=require('../public/source-date-time');

test('cash combines the authenticated business day with Bonzeit, without the Access 1899 anchor or a timezone shift',()=>{
  for(const date of ['2026-01-10','2026-07-10','2026-10-25']) {
    const result=Time.cash({Bondatum:date+'T00:00:00.000',Bonzeit:'1899-12-30T16:40:27.125'});
    assert.equal(result.time,'16:40:27.125');assert.equal(result.dateTime,date+'T16:40:27.125');
    assert.equal(result.timeBasis,'source_local');assert.equal(result.timeSource,'Umsatz_KASSE.Bonzeit');
    assert.equal(result.timeStatus,'source');assert.ok(!result.dateTime.endsWith('Z'));
    assert.match(Time.rowLabel({date,...result}),/16:40:27.125 Uhr/);
  }
});

test('real midnight from Bonzeit is retained; an absent or malformed source time is never invented',()=>{
  const head={Bondatum:'2026-11-14T00:00:00.000'};
  assert.equal(Time.cash({...head,Bonzeit:'1899-12-30T00:00:00.000'}).time,'00:00:00.000');
  for(const Bonzeit of [null,undefined,'','1899-12-30T24:00:00','12:70:00','<script>']) {
    const result=Time.cash({...head,Bonzeit});assert.equal(result.time,null);assert.equal(result.dateTime,null);
    assert.match(Time.rowLabel({date:'2026-11-14',...result}),result.timeStatus==='invalid'?/Uhrzeit ungeklärt/:/Uhrzeit nicht erfasst/);
  }
});

test('day-only journal dates stay day-only, while genuine source datetime components survive in movements',()=>{
  for(const date of ['2026-11-14','2026-11-14T00:00:00.000']) {
    const result=Time.project(date,{source:'Tagesbericht.Bondatum'});
    assert.equal(result.timeStatus,'date_only');assert.equal(result.time,null);assert.equal(result.dateTime,null);
  }
  const value='2026-11-14T19:12:05.987';
  assert.equal(Time.project(value,{source:'WE.WEDatum'}).dateTime,value);
  assert.equal(Time.sourceLabel(value),'14.11.2026 · 19:12:05.987 Uhr');
  assert.equal(Time.sourceLabel('2026-11-14T00:00:00.000'),'14.11.2026');
});

test('source datetime rejects rolled dates and offsets; a supplied business day cannot be replaced by the time anchor',()=>{
  for(const value of ['2026-02-30T10:00:00','2026-11-14T12:00:00+01:00','2026-11-14T12:00','bad'])assert.equal(Time.civil(value),null);
  assert.equal(Time.cash({Bonzeit:'1899-12-30T16:40:27'},'2026-11-14').dateTime,'2026-11-14T16:40:27');
  assert.equal(Time.cash({Bonzeit:'1899-12-30T16:40:27'}).dateTime,null);
  const conflict=Time.cash({Bondatum:'2026-11-14',Bonzeit:'2026-11-13T16:40:27'});
  assert.equal(conflict.dateTime,null);assert.equal(conflict.timeStatus,'invalid');
  assert.equal(Time.cash({Bondatum:'2026-11-14',Bonzeit:'2026-11-14T16:40:27'}).dateTime,'2026-11-14T16:40:27');
});

test('technical UTC timestamps use Vienna summer/winter time independently of Access civil values',()=>{
  assert.match(Time.instantLabel('2026-01-10T16:40:27Z'),/17:40:27/);
  assert.match(Time.instantLabel('2026-07-10T16:40:27Z'),/18:40:27/);
  assert.equal(Time.instantLabel('2026-07-10T16:40:27'),'–');
  assert.equal(Time.sourceLabel('2026-07-10T16:40:27'),'10.07.2026 · 16:40:27 Uhr');
});
