
"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {browserSessionLifetime,mobileSessionLifetime,clampMobileAccessExpiry,isSessionTimeValid,instant,isPrivilegedSession}=require("../lib/portal-session-security");
const NOW=new Date("2026-10-18T12:00:00.000Z");
test("Browser limits are fixed by role and effective administrative grants",()=>{
 const normal=browserSessionLifetime({now:NOW,idleMinutes:480});
 assert.equal(normal.absoluteExpiresAt,"2026-10-19T00:00:00.000Z");
 assert.equal(normal.expiresAt,"2026-10-18T20:00:00.000Z");
 for(const actor of [{role:"developer"},{role:"admin"},{role:"it_admin"},{role:"employee",permissions:["rights:write"]},{permissions:["backup:write"]}]){
  const result=browserSessionLifetime({now:NOW,...actor});
  assert.equal(result.absoluteExpiresAt,"2026-10-18T20:00:00.000Z");assert.equal(result.expiresAt,"2026-10-18T12:30:00.000Z");
 }
 assert.equal(isPrivilegedSession({role:"employee",permissions:["own_time:read"]}),false);
});
test("Rotation and new privilege cannot reset authentication age or extend a deadline",()=>{
 const previous=browserSessionLifetime({now:NOW}),now=new Date(NOW.getTime()+HOUR);
 const rotated=browserSessionLifetime({now,...previous});
 assert.equal(rotated.authenticatedAt,previous.authenticatedAt);assert.equal(rotated.absoluteExpiresAt,previous.absoluteExpiresAt);
 const elevated=browserSessionLifetime({now,authenticatedAt:previous.authenticatedAt,absoluteExpiresAt:previous.absoluteExpiresAt,role:"admin"});
 assert.equal(elevated.absoluteExpiresAt,"2026-10-18T20:00:00.000Z");
 const close=browserSessionLifetime({now:new Date("2026-10-18T23:59:00Z"),...previous});
 assert.equal(close.expiresAt,previous.absoluteExpiresAt);
});
const HOUR=3600000;
for(const [label,origin,end,now] of [
 ["missing origin",undefined,"2026-10-18T20:00:00Z",NOW],
 ["missing end","2026-10-18T12:00:00Z",undefined,NOW],
 ["future origin","2026-10-18T13:00:00Z","2026-10-18T20:00:00Z",NOW],
 ["exact expiry","2026-10-18T10:00:00Z","2026-10-18T12:00:00Z",NOW],
 ["invalid origin","garbage","2026-10-18T20:00:00Z",NOW],
 ["impossible date","2026-02-30T00:00:00Z","2026-10-18T20:00:00Z",NOW],
])test("Inherited browser state fails closed: "+label,()=>assert.equal(browserSessionLifetime({now,authenticatedAt:origin,absoluteExpiresAt:end}),null));
test("Session boundary is inclusive and legacy SQL timestamps have explicit UTC semantics",()=>{
 const s={authenticated_at:"2026-10-18 11:00:00",expires_at:"2026-10-18T13:00:00.000Z",absolute_expires_at:"2026-10-18T12:00:01.000Z"};
 assert.equal(isSessionTimeValid(s,NOW),true);assert.equal(isSessionTimeValid(s,new Date("2026-10-18T12:00:01Z")),false);
 assert.equal(instant("2026-10-18 11:00:00"),Date.parse("2026-10-18T11:00:00Z"));
 assert.ok(Number.isNaN(instant("2026-10-18T11:00:00")));
});
test("Mobile ordinary lifetime is 30 days and privileged lifetime is eight hours",()=>{
 const normal=mobileSessionLifetime({now:NOW}),privileged=mobileSessionLifetime({now:NOW,permissions:["rights:write"]});
 assert.equal(normal.refreshExpiresAt,"2026-11-17T12:00:00.000Z");assert.equal(normal.accessExpiresAt,"2026-10-18T12:15:00.000Z");
 assert.equal(privileged.refreshExpiresAt,"2026-10-18T20:00:00.000Z");assert.equal(privileged.idleMinutes,30);
 assert.equal(clampMobileAccessExpiry(new Date("2026-11-17T11:59:59Z"),normal.refreshExpiresAt),normal.refreshExpiresAt);
 assert.throws(()=>clampMobileAccessExpiry(new Date(normal.refreshExpiresAt),normal.refreshExpiresAt),{code:"PORTAL_SESSION_TIME_INVALID"});
});
