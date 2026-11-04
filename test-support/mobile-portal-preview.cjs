'use strict';
// Screenshot fixture: unmodified product HTML/CSS/JS with synthetic API data.
// No database, external calls, credentials, production proxy or write operations.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const root = path.resolve(__dirname, '../public');
async function createMobilePortalPreview({branch=false,contact=true,restricted=false}={}) {
const modules = ['time','tasks','schedule','requests','branchOrders','loan','sickness','learning'];
const status = {portalEnabled:true,operationMode:'server',branding:{},capabilities:{timeTracking:true,loans:true,sicknessReports:true}};
const user = {employeeNumber:'BEISPIEL',fullName:'Beispielkonto',nickname:'Beispielkonto',role:'employee',roleName:'Mitarbeiterkonto',isEmployee:true,homeLocationId:'18',mustChangePassword:false,
  permissions:['own_schedule:read','own_time:read','own_time:write','own_vacation:read','own_vacation:request','branch_orders:submit','loans:self:read','own_sickness:read','own_sickness:create','own_amu:read','own_amu:create']};
if(branch) Object.assign(user,{isEmployee:false,accountType:'branch',isOrganizationAccount:true,permissions:['branch_schedule:read','branch_orders:submit']});
if(restricted) user.permissions=[];
const fixtures = {
 '/api/portal/v1/status':status,
 '/api/portal/v1/session':{authenticated:true,user,status},
 '/api/portal/v1/ui-preferences':{mobilePortalLocationDisplay:{version:1,locationId:'18',allowedModules:modules},mobilePortalAppearance:{version:1,palette:'forest',surface:'soft'},mobilePortalHome:{version:1,order:['schedule','branchOrders','requests','time','tasks','loan','sickness','learning'],colors:{}},windowPreferences:{}},
 '/api/portal/v1/emma-contact':{contact:contact?{href:'https://wa.me/436601234567',avatar:'/assets/emma-whatsapp.png'}:null},
 '/api/portal/v1/private-workspaces':{workspaces:[{id:'capture',title:'Capture',url:'/api/portal/v1/private-workspaces/capture/page',camera:true,launch:{label:'Capture',color:'#0064dd'}}]},
 '/api/portal/v1/me/home':{greeting:{enabled:false}},
 '/api/portal/v1/me/notifications':{notifications:[],unreadCount:0},
 '/api/portal/v1/me/process-tasks':{available:true,tasks:[],summary:{total:0}},
 '/api/portal/v1/me/schedule':{weekStart:'2026-10-26',weekEnd:'2026-11-01',calendarWeek:44,shifts:[],days:[]},
 '/api/portal/v1/me/time-off-requests':{requests:[]},
 '/api/portal/v1/me/vacation-requests':{requests:[]},
 '/api/portal/v1/me/approved-vacations':{vacations:[]},
 '/api/portal/v1/me/absence-history':{items:[]},
 '/api/portal/v1/me/sickness-cases':{cases:[]},
 '/api/portal/v1/me/amu-reports':{reports:[]},
 '/api/portal/v1/loans/status':{available:true},
};
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff2':'font/woff2'};
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1');
 if(req.method!=='GET'){res.writeHead(405);res.end('Read-only preview');return;}
 if(url.pathname.startsWith('/api/')){
   if(url.pathname.includes('personnel-learning/dashboard')){res.writeHead(403,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Nicht freigeschaltet im Beispielkonto'}));return;}
   res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
   res.end(JSON.stringify(fixtures[url.pathname]||{}));return;
 }
 const file=path.resolve(root,url.pathname==='/'?'portal.html':decodeURIComponent(url.pathname).slice(1));
 if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
 res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store',
  'Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; font-src 'self' data:"});
 res.end(fs.readFileSync(file));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
return {origin:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
module.exports={createMobilePortalPreview};
