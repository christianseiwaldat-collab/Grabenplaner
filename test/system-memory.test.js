'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {systemMemorySummary}=require('../lib/system-memory');
test('Linux cache remains available memory instead of appearing as application use',()=>{
  const result=systemMemorySummary({platform:'linux',totalBytes:8*1024**3,freeBytes:1024**3,
    readMeminfo:()=> 'MemTotal: 8388608 kB\nMemFree: 1048576 kB\nMemAvailable: 5242880 kB\nCached: 4194304 kB\n'});
  assert.equal(result.usedPercent,38);assert.equal(result.availableBytes,5*1024**3);assert.equal(result.freeBytes,1024**3);
  assert.equal(result.availabilitySource,'mem_available');
});
test('missing, invalid and unsupported memory data retain the OS fallback',()=>{
  for(const readMeminfo of [()=>'',()=>{throw Error('missing');},()=> 'MemAvailable: 999999999999999999 kB',()=> 'MemAvailable: -1 kB']){
    assert.equal(systemMemorySummary({platform:'linux',totalBytes:8000,freeBytes:2000,readMeminfo}).usedPercent,75);
  }
  assert.equal(systemMemorySummary({platform:'win32',totalBytes:8000,freeBytes:2000,readMeminfo:()=>{throw Error('must not read');}}).availableBytes,2000);
});
