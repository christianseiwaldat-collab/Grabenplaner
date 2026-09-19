"use strict";
// Run only on a disposable Ubuntu VM / GitHub-hosted runner with real systemd:
// sudo env GP681_DISPOSABLE_SYSTEMD_QA=1 /absolute/node this-file.cjs /absolute/maintenance-schedule-broker.js
// Never run on the production VPS. No app/database/backup fixtures are used.
const fs=require("node:fs"), os=require("node:os"), path=require("node:path");
const assert=require("node:assert/strict"), cp=require("node:child_process"), crypto=require("node:crypto");
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function exec(args,allowFailure=false){
 const r=cp.spawnSync("/usr/bin/systemctl",args,{encoding:"utf8",timeout:10000,env:{PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C"}});
 if(!allowFailure)assert.equal(r.status,0,JSON.stringify({args,status:r.status,stderr:r.stderr}));
 return r;
}
async function main(){
 assert.equal(process.platform,"linux","Requires Linux; never simulate this regression.");
 assert.equal(process.getuid(),0,"Requires root on the disposable test machine.");
 assert.equal(process.env.GP681_DISPOSABLE_SYSTEMD_QA,"1","Explicit disposable-test opt-in required.");
 for(const p of ["/opt/grabenplaner/app","/etc/grabenplaner","/var/lib/grabenplaner"]){
  assert.equal(fs.existsSync(p),false,"Production marker exists: refusing all mutation.");
 }
 assert.equal(fs.readFileSync("/proc/1/comm","utf8").trim(),"systemd","PID 1 must be a real systemd manager.");
 const brokerPath=fs.realpathSync(process.argv[2]||"");
 const broker=require(brokerPath);
 const prefix="gp681-matrix-qa-"+crypto.randomBytes(6).toString("hex");
 const future=new Date(Date.now()+2*3600000);
 const customTime=String(future.getHours()).padStart(2,"0")+":"+String(future.getMinutes()).padStart(2,"0");
 const root=fs.mkdtempSync(path.join(os.tmpdir(),prefix+"-"));
 const stateRoot=path.join(root,"state"), systemdRoot=path.join(root,"dropins");
 fs.mkdirSync(stateRoot,{mode:0o700});fs.mkdirSync(systemdRoot,{mode:0o755});
 const units=new Map(), markers=new Map(), created=[];
 const taskTimers=[];
 const stamp=unit=>"/var/lib/systemd/timers/stamp-"+unit;
 for(const task of broker.TASKS){
  units.set(task.timer,prefix+"-"+task.id+".timer");
  for(const service of task.services)units.set(service,prefix+"-"+service.replaceAll("@","-"));
  markers.set(task.id,path.join(root,task.id+".ran"));
 }
 const install=(file,body)=>{assert.ok(!fs.existsSync(file));fs.writeFileSync(file,body,{mode:0o644,flag:"wx"});created.push(file);};
 try{
  for(const task of broker.TASKS){
   const original=broker.defaultSchedules().find(x=>x.id===task.id);
   // Custom value proves first display reads effective systemd configuration.
   if(task.id==="complete-backup")original.time=customTime;
   for(const service of task.services){
    install("/etc/systemd/system/"+units.get(service),"[Unit]\nDescription=GP681 synthetic timer QA only\n[Service]\nType=oneshot\nExecStart=/usr/bin/touch "+markers.get(task.id)+"\n");
   }
   const timer=units.get(task.timer);taskTimers.push(timer);
   install("/etc/systemd/system/"+timer,"[Unit]\nDescription=GP681 synthetic timer QA only\n[Timer]\nOnCalendar="+broker.calendarExpression(original)+"\n"+(task.id==="security-audit"?"OnBootSec=10min\n":"")+"Persistent=true\nRandomizedDelaySec=0\nFixedRandomDelay=false\nAccuracySec=1us\nUnit="+units.get(task.services[0])+"\n[Install]\nWantedBy=timers.target\n");
   const ownDropin=path.join(systemdRoot,task.timer+".d");
   fs.mkdirSync(ownDropin,{mode:0o755});
   const alias="/etc/systemd/system/"+timer+".d";
   assert.ok(!fs.existsSync(alias));fs.symlinkSync(ownDropin,alias,"dir");created.push(alias);
  }
  exec(["daemon-reload"]);
  const calls=[];
  const options={stateRoot,systemdRoot,spawnSync:(command,args,spawnOptions)=>{
   assert.equal(command,"/usr/bin/systemctl");
   // Translate only fixed test unit identities. All operations execute the real
   // manager; effective properties and persistent state are never mocked.
   const mapped=args.map(arg=>units.get(arg)||arg);
   assert.ok(!mapped.some(arg=>arg.startsWith("grabenplaner")));
   calls.push(mapped);
   const r=cp.spawnSync(command,mapped,spawnOptions);
   let stdout=r.stdout||"";
   for(const [original,alias] of units)stdout=stdout.replaceAll(alias,original);
   return {...r,stdout};
  }};
  const schedules=snapshot=>snapshot.tasks.map(({id,enabled,cadence,weekdays,time,intervalMinutes,monthDay})=>({id,enabled,cadence,weekdays,time,intervalMinutes,monthDay}));
  let before=broker.scheduleSnapshot(options);
  assert.equal(before.tasks.find(x=>x.id==="complete-backup").time,customTime);
  assert.equal(before.tasks.find(x=>x.id==="security-audit").unsupportedReason,"additional-triggers");
  const timer=units.get("grabenplaner-offsite-assurance.timer"), marker=markers.get("complete-backup");
  // Positive control: prove this real manager catches up when given an old stamp.
  exec(["start",timer]);exec(["stop",timer]);
  assert.equal(fs.existsSync(marker),false,"A fresh timer unexpectedly fired; positive control is inconclusive.");
  assert.ok(fs.statSync(stamp(timer)).isFile());
  const old=new Date(Date.now()-3*86400000);
  fs.utimesSync(stamp(timer),old,old);
  exec(["start",timer]);
  const until=Date.now()+10000;
  while(!fs.existsSync(marker)&&Date.now()<until)await sleep(100);
  assert.ok(fs.existsSync(marker),"Positive control did not catch up; result is inconclusive.");
  exec(["stop",timer]);fs.unlinkSync(marker);
  fs.utimesSync(stamp(timer),old,old);
  before=broker.scheduleSnapshot(options);
  const input=schedules(before);input.find(x=>x.id==="complete-backup").enabled=true;
  calls.length=0;
  const after=broker.applySchedules(input,{...options,expectedRevision:before.revision});
  await sleep(2200);
  assert.equal(fs.existsSync(marker),false,"Saving/re-enabling unexpectedly triggered the worker.");
  const item=after.tasks.find(x=>x.id==="complete-backup");
  assert.ok(item.enabled&&item.active);
  assert.ok(Date.parse(item.nextRunAt)>Date.now(),"Next trigger is not in the future.");
  const actions=calls.filter(args=>["stop","clean","start"].includes(args[0]));
  assert.deepEqual(actions,[["stop",timer],["clean","--what=state",timer],["start",timer]]);
  const mutations=()=>calls.filter(args=>["stop","clean","start","enable","disable","daemon-reload"].includes(args[0]));
  calls.length=0;
  broker.applySchedules(schedules(after),{...options,expectedRevision:after.revision});
  assert.equal(mutations().length,0,"Untouched save mutated a timer.");
  assert.equal(fs.existsSync(marker),false);
  console.log(JSON.stringify({ok:true,systemd:exec(["--version"]).stdout.split("\n")[0],checks:["effective-custom-calendar","unsupported-boot-trigger","positive-catch-up-control","safe-reenable-no-catch-up","future-next-run","unchanged-save-no-timer-mutations"],synthetic:true}));
 }finally{
  for(const timer of taskTimers){exec(["stop",timer],true);exec(["disable",timer],true);exec(["clean","--what=state",timer],true);}
  for(const [original,alias] of units)if(original.endsWith(".service"))exec(["stop",alias],true);
  for(const file of created.reverse()){
   assert.ok(file.startsWith("/etc/systemd/system/"+prefix+"-"));
   fs.unlinkSync(file);
  }
  exec(["daemon-reload"],true);
  for(const alias of units.values())exec(["reset-failed",alias],true);
  assert.ok(root.startsWith(path.join(os.tmpdir(),prefix+"-")));
  fs.rmSync(root,{recursive:true,force:true});
 }
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
