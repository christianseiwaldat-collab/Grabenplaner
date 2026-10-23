'use strict';
// Opt-in local compatibility proof. Fixtures were captured from tedious 20.0.0
// before removal. Only synthetic values and a loopback fake TDS peer are used.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const net=require('node:net');
const {createRequire}=require('node:module');
const tedious=require('tedious');
const driverRequire=createRequire(require.resolve('tedious'));
const fixtures=require('./ops-sprintf-compatibility-fixtures.json');
const Login=require('tedious/lib/login7-payload');
const Prelogin=require('tedious/lib/prelogin-payload');
const {Packet,TYPE}=require('tedious/lib/packet');
const {readMetadata}=require('tedious/lib/metadata-parser');
const {readValue}=require('tedious/lib/value-parser');
const {createSqlServerProvider}=require('../../lib/sql-view-source');
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');

test('upstream release removes sprintf-js from runtime resolution and all-platform lockfile',()=>{
  assert.equal(require('tedious/package.json').version,'20.3.7');
  assert.equal(require('tedious/package.json').engines.node,'>=22');
  assert.equal(require('tedious/package.json').dependencies['sprintf-js'],undefined);
  for(const parent of [require,driverRequire])assert.throws(()=>parent.resolve('sprintf-js'),{code:'MODULE_NOT_FOUND'});
  const lock=fs.readFileSync(path.resolve(__dirname,'../../pnpm-lock.yaml'),'utf8');
  assert.doesNotMatch(lock,/sprintf-js/);
  for(const name of ['login7-payload','prelogin-payload','packet','metadata-parser','value-parser']){
    assert.doesNotMatch(fs.readFileSync(require.resolve('tedious/lib/'+name),'utf8'),/require\(['"]sprintf-js['"]\)/);
  }
});
test('upstream hex formatter preserves widths, uint32 wrapping and nontruncation',()=>{
  const {formatHex}=require('tedious/lib/format-hex');
  for(const [value,width,expected] of [[0,2,'00'],[255,2,'FF'],[256,2,'100'],[65535,4,'FFFF'],[1,8,'00000001'],[-1,8,'FFFFFFFF'],[4294967296,8,'00000000'],[15.9,4,'000F']])assert.equal(formatHex(value,width),expected);
});
test('six Login7 cases retain all four former formatted lines and exact wire bytes',()=>{
  for(const x of fixtures.login){const p=new Login(x.args);Object.assign(p,x.props);p.clientId=Buffer.from([0,1,2,3,4,5]);assert.equal(p.toString('  '),x.text);assert.equal(hash(p.toBuffer()),x.wireSha256);}
});
test('two Prelogin responses retain text and parsed wire data',()=>{
  for(const x of fixtures.prelogin){const p=new Prelogin(Buffer.from(x.wire,'hex'));assert.equal(p.toString('  '),x.text);assert.equal(p.data.toString('hex'),x.wire);}
});
test('eight packet boundaries retain header, dump and wire bytes including every byte value',()=>{
  for(const x of fixtures.packet){const p=new Packet(TYPE.SQL_BATCH);p.last(true);p.packetId(17);p.addData(Buffer.from(Array.from({length:x.size},(_,i)=>i%256)));assert.equal(p.headerToString('  '),x.header);assert.equal(hash(p.dataToString('  ')),x.dumpSha256);assert.equal(hash(p.buffer),x.wireSha256);}
});
test('metadata unknown numeric type keeps its hexadecimal error',()=>{
  assert.throws(()=>readMetadata(Buffer.from([0,0,0,0,0,0,255]),0,{tdsVersion:'7_4'}),{message:'Unrecognised data type 0xFF'});
});
test('metadata unknown type name treats precision payload as ordinary data',()=>{
  const types=require('tedious/lib/data-type').TYPE, previous=types[255];
  try{types[255]={name:'%.1000f'};assert.throws(()=>readMetadata(Buffer.from([0,0,0,0,0,0,255]),0,{tdsVersion:'7_4'}),{message:'Unrecognised type %.1000f'});}
  finally{if(previous===undefined)delete types[255];else types[255]=previous;}
});
test('GUID and numeric invalid lengths retain both decimal error messages',()=>{
  assert.throws(()=>readValue(Buffer.from([2]),0,{type:{name:'UniqueIdentifier'}},{}),{message:'Unsupported guid size 1'});
  assert.throws(()=>readValue(Buffer.from([2,1,0]),0,{type:{name:'NumericN'},precision:5,scale:0},{}),{message:'Unsupported numeric dataLength 2'});
});
test('GP SQL adapter uses real Request/NVarChar APIs for parameterized metadata and reads',async()=>{
  const provider=createSqlServerProvider(),seen=[];
  const connection={execSql(request){assert.ok(request instanceof tedious.Request);seen.push(request);
    if(request.sqlTextOrProcedure.includes('INFORMATION_SCHEMA.COLUMNS')){
      assert.deepEqual(request.parameters.map(p=>[p.name,p.value,p.type.id]),[['schema','dbo',tedious.TYPES.NVarChar.id],['view','View %.1000f',tedious.TYPES.NVarChar.id]]);
      request.emit('row',[{value:'Name'},{value:1},{value:'nvarchar'},{value:'YES'}]);
    }else{request.emit('columnMetadata',[{colName:'Name',type:tedious.TYPES.NVarChar,nullable:true}]);request.emit('row',[{value:'Grüße %.1000f'}]);}
    request.callback(null);
  }};
  assert.deepEqual(await provider.listColumns(connection,{schema:'dbo',name:'View %.1000f'}),[{name:'Name',ordinal:1,dataType:'nvarchar',nullable:true}]);
  assert.deepEqual(await provider.readRows(connection,{schema:'dbo',name:'View',columns:['Name'],maxRows:10}),[['Grüße %.1000f']]);
  assert.equal(seen.length,2);
});
test('GP opens the actual Connection constructor with its intended TLS/read-only settings',async()=>{
  let seen;
  class LocalConnection extends tedious.Connection {
    constructor(config){super(config);seen=this;}
    connect(){queueMicrotask(()=>this.emit('connect',null));}
    close(){this.closed=true;}
  }
  const provider=createSqlServerProvider({loadTedious:()=>({...tedious,Connection:LocalConnection})});
  const connection=await provider.open({server:'synthetic.invalid',port:1433,database:'fixture',encrypt:true,trustServerCertificate:false,connectionTimeoutMs:200,queryTimeoutMs:200},{username:'synthetic',password:'synthetic'});
  assert.equal(connection,seen);assert.equal(seen.config.options.encrypt,true);assert.equal(seen.config.options.trustServerCertificate,false);assert.equal(seen.config.options.readOnlyIntent,true);
  await provider.close(connection);assert.equal(seen.closed,true);
});
test('real Connection.execSql resolves GP parameters and serializes the async RPC payload',async()=>{
  const connection=new tedious.Connection({server:'synthetic.invalid',options:{encrypt:true,trustServerCertificate:false}});
  let wire;
  connection.makeRequest=(request,type,payload)=>{
    assert.equal(type,TYPE.RPC_REQUEST);
    assert.deepEqual(payload.parameters.map(p=>p.name),['statement','params','schema','view']);
    assert.deepEqual(request.resolvedParameters.map(p=>p.data.value),['dbo','View Grüße %.1000f']);
    (async()=>{const buffers=[];for await(const chunk of payload)buffers.push(chunk);wire=Buffer.concat(buffers);request.emit('row',[{value:'Name'},{value:1},{value:'nvarchar'},{value:'YES'}]);request.callback(null);})().catch(error=>request.callback(error));
  };
  try{
    const result=await createSqlServerProvider().listColumns(connection,{schema:'dbo',name:'View Grüße %.1000f'});
    assert.equal(result[0].name,'Name');assert.ok(wire.length>32);
    for(const text of ['INFORMATION_SCHEMA.COLUMNS','@schema nvarchar(3)','View Grüße %.1000f'])assert.ok(wire.includes(Buffer.from(text,'utf16le')),text);
  }finally{connection.close();}
});
test('native Row/PLP parser preserves fragmented UTF16, surrogate pairs, null and the following row',async()=>{
  const imported=require('tedious/lib/token/stream-parser'),Parser=imported.default||imported;
  const text='Grüße %.1000f 😀',data=Buffer.from(text,'utf16le');
  const u32=value=>{const b=Buffer.alloc(4);b.writeUInt32LE(value);return b;};
  const total=Buffer.alloc(8);total.writeBigUInt64LE(BigInt(data.length));
  const wire=Buffer.concat([Buffer.from([0xd1]),u32(42),total,u32(3),data.subarray(0,3),u32(data.length-3),data.subarray(3),u32(0),Buffer.from([0xd1]),u32(43),Buffer.alloc(8,255)]);
  const metadata=[{type:tedious.TYPES.Int,colName:'Id'},{type:tedious.TYPES.NVarChar,dataLength:0xffff,colName:'Name'}];
  const decode=async bytes=>{const rows=[];for await(const token of Parser.parseTokens(Array.from(bytes,value=>Buffer.from([value])),{tdsVersion:'7_4',useUTC:true,useColumnNames:false,lowerCaseGuids:false},metadata))rows.push(token.columns.map(column=>column.value));return rows;};
  assert.deepEqual(await decode(wire),[[42,text],[43,null]]);
  await assert.rejects(decode(wire.subarray(0,-1)),/unexpected end of data/);
});
test('real GP driver rejects a loopback PRELOGIN TLS downgrade before any Login7 packet',{timeout:5000},async()=>{
  const sockets=new Set(),packetTypes=[];
  const server=net.createServer(socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));let pending=Buffer.alloc(0),sent=false;
    socket.on('error',()=>{});
    socket.on('data',chunk=>{pending=Buffer.concat([pending,chunk]);while(pending.length>=8&&pending.length>=pending.readUInt16BE(2)){
      const size=pending.readUInt16BE(2);packetTypes.push(pending[0]);pending=pending.subarray(size);
      if(!sent){sent=true;const body=Buffer.from([1,0,6,0,1,255,2]);const header=Buffer.from([4,1,0,15,0,0,0,0]);socket.write(Buffer.concat([header,body]));}
    }});
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try{
    const provider=createSqlServerProvider();
    await assert.rejects(provider.open({server:'127.0.0.1',port:server.address().port,database:'synthetic',encrypt:true,trustServerCertificate:false,connectionTimeoutMs:1000,queryTimeoutMs:1000},{username:'synthetic-only',password:'synthetic-only'}),error=>error.code==='EENCRYPT');
    assert.deepEqual(packetTypes,[TYPE.PRELOGIN]);
  }finally{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));}
});
