const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require('node:vm');

const { fromNetwork, fromResponse, isCodespacesHostname } = require("../public/api-errors");

test("Codespaces-Proxyfehler werden verständlich erklärt", async () => {
  const hostname = "beispiel-3000.app.github.dev";
  assert.equal(isCodespacesHostname(hostname), true);

  const startup = await fromResponse(new Response("<html>Bad Gateway</html>", {
    status: 502,
    headers: { "Content-Type": "text/html" },
  }), { hostname });
  assert.match(startup.message, /Codespace wird gerade gestartet/);
  assert.match(startup.message, /Open in Browser/);

  const expired = await fromResponse(new Response("Anmeldung erforderlich", { status: 401 }), { hostname });
  assert.match(expired.message, /Codespaces-Anmeldung ist abgelaufen/);

  const network = fromNetwork(new TypeError("Failed to fetch"), { hostname });
  assert.equal(network.code, "CODESPACES_PROXY_UNREACHABLE");
});

test("JSON-Fehler der App bleiben unverändert erhalten", async () => {
  const detail = await fromResponse(new Response(JSON.stringify({
    error: "Personalnummer oder Passwort ist nicht korrekt.",
    code: "PORTAL_LOGIN_FAILED",
  }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  }), { hostname: "beispiel-3000.app.github.dev" });

  assert.deepEqual(detail, {
    message: "Personalnummer oder Passwort ist nicht korrekt.",
    code: "PORTAL_LOGIN_FAILED",
  });
});

test("Nicht-Codespaces-Antworten behalten einen neutralen HTTP-Hinweis", async () => {
  const detail = await fromResponse(new Response("Fehler", { status: 500 }), {
    hostname: "localhost",
    fallback: "Die Aktion konnte nicht ausgeführt werden.",
  });
  assert.equal(detail.message, "Die Aktion konnte nicht ausgeführt werden. (HTTP 500).");
});

test("Admin- und Mitarbeiteroberfläche laden die Fehlerhilfe vor dem jeweiligen App-Skript", () => {
  const publicRoot = path.join(__dirname, "..", "public");
  const admin = fs.readFileSync(path.join(publicRoot, "index.html"), "utf8");
  const portal = fs.readFileSync(path.join(publicRoot, "portal.html"), "utf8");
  assert.ok(admin.indexOf('/api-errors.js') < admin.indexOf('/app.js'));
  assert.ok(portal.indexOf('/api-errors.js') < portal.indexOf('/portal.js'));
});

test('Both login clients preserve a useful server error when the optional error script failed to load',async()=>{
 for(const name of ['app.js','portal.js']){
  const source=fs.readFileSync(path.join(__dirname,'../public',name),'utf8').replaceAll('\r\n','\n');
  const start=source.indexOf('async function api('),end=source.indexOf('\n}\n',start)+2;
  const context={window:{},document:{cookie:''},location:{hostname:'beta.grabenplaner.eu'},elements:{},FormData,Error,csrf:()=>'',showLogin:()=>{},fetch:async()=>new Response(JSON.stringify({error:'Bitte kurz warten.',code:'PERSISTENCE_BUSY'}),{status:503})};
  vm.createContext(context);vm.runInContext(source.slice(start,end)+'\nthis.request=api;',context);
  await assert.rejects(context.request('/api/portal/v1/auth/login'),e=>e.message==='Bitte kurz warten.'&&e.code==='PERSISTENCE_BUSY'&&e.status===503);
 }
});
