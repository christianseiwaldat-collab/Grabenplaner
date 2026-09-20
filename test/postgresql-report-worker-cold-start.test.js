'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),net=require('node:net');
const {createSalesReportBatchWorker}=require('../lib/sales-report-batch-worker');

test('cold PostgreSQL worker preserves a real driver startup failure across the thread boundary',async t=>{
  // A local protocol fixture rejects startup with SQLSTATE 53300. The actual
  // worker, catalogs, pg client, phase reporting and error transport all run;
  // no real database, account or production connection is involved.
  let connections=0;
  const sockets=new Set();
  const server=net.createServer(socket=>{
    connections++;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
    socket.once('data',()=>{
      const payload=Buffer.from('SFATAL\0VFATAL\0C53300\0MSYNTHETIC_PRIVATE_CAPACITY_ERROR\0\0');
      const packet=Buffer.alloc(payload.length+5);packet[0]=69;packet.writeInt32BE(payload.length+4,1);payload.copy(packet,5);
      socket.end(packet);
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});
  const port=server.address().port;
  const worker=createSalesReportBatchWorker({
    workerFile:path.resolve(__dirname,'../lib/persistence/postgresql/reporting/worker.js'),
    workerConfiguration:{profile:'core-migration-development',tlsMode:'disable-local-only',
      coreUrl:`postgresql://gp_core_reader:synthetic@127.0.0.1:${port}/gp_migration_core`,
      salesUrl:`postgresql://gp_sales_reader:synthetic@127.0.0.1:${port}/gp_migration_sales`},
  });
  t.after(()=>worker.stop());
  await assert.rejects(worker.run({operation:'initialize'}),error=>{
    assert.equal(error.code,'IMPORT_REPORT_FAILED',JSON.stringify(error.reportWorkerDiagnostic));
    assert.deepEqual(error.reportWorkerDiagnostic,{phase:'core-database',errorClass:'connection-capacity',originalCode:'53300'});
    assert.doesNotMatch(JSON.stringify(error.reportWorkerDiagnostic),/SYNTHETIC_PRIVATE|synthetic|password|sql|stack/);
    return true;
  });
  assert.equal(connections,1,'the diagnostic change must not introduce connection retries');
});
