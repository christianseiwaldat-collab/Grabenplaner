'use strict';
// Local design review only. No application routes or business data are loaded.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../..');
const files=new Map([
  ['/',[path.join(__dirname,'index.html'),'text/html; charset=utf-8']],
  ['/preview.css',[path.join(__dirname,'preview.css'),'text/css; charset=utf-8']],
  ['/preview.js',[path.join(__dirname,'preview.js'),'text/javascript; charset=utf-8']],
  ['/styles.css',[path.join(root,'public/styles.css'),'text/css; charset=utf-8']],
]);
const server=http.createServer((req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
  const entry=files.get(new URL(req.url,'http://localhost').pathname);
  if(!entry){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':entry[1],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
    'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});
  if(req.method==='HEAD')res.end();else fs.createReadStream(entry[0]).pipe(res);
});
server.listen(0,'127.0.0.1',()=>console.log('DESIGN_PREVIEW=http://127.0.0.1:'+server.address().port));
