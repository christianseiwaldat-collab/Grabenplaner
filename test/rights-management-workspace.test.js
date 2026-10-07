'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const workspace = require('../public/rights-management-workspace');

test('rights table metadata allows only known columns, preserves widths and retains its mandatory identity column', () => {
  const prefs = workspace.normalize({version:1, columns:['name','name','personnel','unknown'],
    order:['personnel','name','employeeNumber','constructor'], sort:'added', direction:'desc',
    columnWidths:JSON.parse('{"name":250,"employeeNumber":80,"personnel":800,"role":801,"revoked":79,"location":12.5,"__proto__":{"bad":true}}'),
    users:[{fullName:'Do not store this'}], search:'No query persistence'});
  assert.deepEqual(prefs.columns,['personnel','name','employeeNumber']);
  assert.deepEqual(prefs.columnWidths,{employeeNumber:80,name:250,personnel:800});
  assert.equal(prefs.sort,'added');assert.equal(prefs.direction,'desc');
  assert.equal(prefs.order.length,workspace.COLUMNS.length);
  assert.equal(new Set(prefs.order).size,workspace.COLUMNS.length);
  assert.deepEqual(Object.keys(prefs),['version','columns','order','columnWidths','sort','direction']);
  assert.doesNotMatch(JSON.stringify(prefs), /Do not store|No query|users|search|constructor/);
  assert.deepEqual(workspace.normalize(prefs),prefs);
});

test('malformed or unsupported metadata falls back safely and never permits an empty table', () => {
  for (const value of [null, [], {version:2,columns:[]}, Object.create({version:1})]) {
    const prefs = workspace.normalize(value);
    assert.ok(prefs.columns.includes('employeeNumber'));assert.ok(prefs.columns.includes('name'));
    assert.equal(prefs.sort,'employeeNumber');assert.equal(prefs.direction,'asc');
  }
  const empty = workspace.normalize({version:1,columns:[],order:[],sort:'__proto__',direction:'invalid'});
  assert.deepEqual(empty.columns,['employeeNumber']);
  assert.equal(empty.sort,'employeeNumber');assert.equal(empty.direction,'asc');
});

test('projection excludes permission values and confidential personnel fields while retaining visible access facts', () => {
  const source = [{employeeNumber:'0017',nickname:'Beispiel',fullName:'Long Name',role:'manager',roleName:'Filialleitung',homeLocationId:'L1',
    configured:true,active:true,manageable:true,grantedPermissions:['schedule:read','schedule:write'],deniedPermissions:['loan:self:use'],
    personnelFieldAccess:{phone:'read',mail:'read',salary:'hidden',notes:'write'},salary:5500,privateMail:'private@example.test'},
  {employeeNumber:'2',fullName:'Ohne Zugang',role:'employee',homeLocationId:'L2',configured:false,manageable:false}];
  const before = JSON.stringify(source), rows = workspace.projectRows(source,[{id:'L1',name:'Beispielfiliale'}]);
  assert.deepEqual(rows[0], {employeeNumber:'0017',name:'Beispiel',fullName:'Long Name',role:'Filialleitung',location:'Beispielfiliale',added:2,revoked:1,
    status:'Bearbeitbar',personnel:'2 lesen · 1 bearbeiten',manageable:true});
  assert.equal(rows[1].status,'Noch nicht eingerichtet');assert.equal(rows[1].personnel,'–');
  assert.doesNotMatch(JSON.stringify(rows),/private@example|salary|schedule:|loan:self|5500/);
  assert.equal(JSON.stringify(source),before);
});

test('personal identifiers sort numerically without dropping leading zeroes and counts compare as numbers', () => {
  const rows = [
    {employeeNumber:'17',name:'Zebra',added:2}, {employeeNumber:'002',name:'Anton',added:10},
    {employeeNumber:'100',name:'Berta',added:1}, {employeeNumber:'3',name:'Emil',added:2},
  ];
  assert.deepEqual(workspace.sortRows(rows,null).map(row => row.employeeNumber),['002','3','17','100']);
  assert.deepEqual(workspace.sortRows(rows,{version:1,sort:'added',direction:'desc'}).map(row => row.employeeNumber),['002','3','17','100']);
  assert.deepEqual(workspace.sortRows(rows,{version:1,sort:'name',direction:'asc'}).map(row => row.name),['Anton','Berta','Emil','Zebra']);
  assert.deepEqual(rows.map(row => row.employeeNumber),['17','002','100','3'],'Sorting does not mutate the source roster');
});

test('search matches number, name, role and location regardless of German case', () => {
  const rows = workspace.projectRows([
    {employeeNumber:'17',nickname:'Markus',fullName:'Markus Mustermann',roleName:'Filialleitung',homeLocationId:'1',configured:true,active:true},
    {employeeNumber:'153',nickname:'Herbert',roleName:'Mitarbeiter',homeLocationId:'2',configured:true,active:false},
  ],[{id:'1',name:'Mitterweg'},{id:'2',name:'Grabenweg'}]);
  for (const term of [' 17 ','MARKUS','MUSTERMANN','filialleitung','MITTERWEG']) assert.equal(workspace.sortRows(rows,null,term)[0]?.employeeNumber,'17');
  assert.equal(workspace.sortRows(rows,null,'grabenweg')[0]?.employeeNumber,'153');
  assert.equal(workspace.sortRows(rows,null,'nicht vorhanden').length,0);
  assert.equal(rows[1].status,'Inaktiv');
});
