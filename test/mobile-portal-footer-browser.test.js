"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createMobilePortalPreview } = require("../test-support/mobile-portal-preview.cjs");
const enabled = process.env.GP_WINDOW_BROWSER_TEST === "1";
let browser;
test.before(async () => { if (enabled) browser = await require(process.env.GP_BROWSER_TEST_MODULE || "playwright").chromium.launch({ headless:true, chromiumSandbox: process.platform === "linux", ...(process.env.GP_BROWSER_EXECUTABLE ? {executablePath:process.env.GP_BROWSER_EXECUTABLE} : {}) }); });
test.after(async () => { await browser?.close(); });

async function fixture(width, options={}) {
  const server=await createMobilePortalPreview(options);
  const context=await browser.newContext({viewport:{width,height:844}}), page=await context.newPage();
  // Even an accidental click must never contact WhatsApp or a productive host.
  await context.route("**/*",route=>new URL(route.request().url()).origin===server.origin?route.continue():route.abort());
  await page.goto(server.origin+"/portal.html?tab=home");
  await page.locator("#portalApp:not(.hidden)").waitFor();
  return {page,close:async()=>{await context.close();await server.close();}};
}

for(const width of [320,390]) test(`personal mobile footer at ${width}: Start / Emma, More tile and permitted navigation`,{skip:!enabled},async()=>{
  const f=await fixture(width); const p=f.page;
  try {
    await p.getByRole("button",{name:"Mehr Weitere Bereiche"}).waitFor();
    assert.deepEqual(await p.locator(".portal-tabs button:visible").allTextContents(),["Start"]);
    const start=await p.locator("#mobileHomeTab").boundingBox(), emma=await p.locator("#emmaWhatsappContact").boundingBox();
    assert.ok(emma.x>start.x+start.width && emma.y>700 && emma.y+emma.height<=844);
    assert.equal(await p.locator("#mobileHomeView #emmaWhatsappContact").count(),0);
    assert.equal(await p.locator("#emmaWhatsappContact .emma-contact-avatar").evaluate(e=>e.getBoundingClientRect().width),40);
    assert.equal(await p.locator("#emmaWhatsappContact").getAttribute("href"),"https://wa.me/436601234567");
    const sick=await p.locator('[data-mobile-home-tab="amu"]').boundingBox(), more=await p.locator(".mobile-home-more").boundingBox();
    assert.equal(Math.round(more.x),Math.round(sick.x)); assert.ok(more.y>sick.y+sick.height);
    await p.getByRole("button",{name:"Mehr Weitere Bereiche"}).click();
    await p.locator("#leadershipMoreView.active").waitFor();
    for(const tab of ["timeTracking","schedule","history","timeOff","vacation","amu","processTasks","loan","branchOrders"])
      assert.equal(await p.locator(`#leadershipMoreView [data-more-tab="${tab}"]`).isVisible(),true,tab);
    assert.equal(await p.locator('[data-more-tab="leadershipApprovals"]').isVisible(),false);
    await p.locator('[data-more-tab="history"]').click(); await p.locator("#historyView.active").waitFor();
    assert.equal(await p.locator("#emmaWhatsappContact").isVisible(),true);
    await p.getByRole("tab",{name:"Start",exact:true}).click(); await p.locator("#mobileHomeView.active").waitFor();
    await p.getByRole("button",{name:"Einstellungen öffnen"}).click(); await p.locator("#settingsView.active").waitFor();
    assert.equal(await p.locator("#mobileNavigationSettingsCard").isVisible(),false);
    assert.equal(await p.locator("#mobileHomeTab").isVisible(),true);
    await p.getByRole("tab",{name:"Start",exact:true}).click(); await p.locator("#mobileHomeView.active").waitFor();
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  } finally {await f.close();}
});

test("desktop and branch accounts retain their navigation; unavailable Emma stays hidden",{skip:!enabled},async()=>{
  for(const [width,options] of [[1280,{}],[390,{branch:true}],[390,{contact:false,restricted:true}]]) {
    const f=await fixture(width,options); const p=f.page;
    try {
      await p.locator(".portal-view.active").waitFor();
      assert.equal(await p.locator("#emmaWhatsappContact").isVisible(),false);
      if(width===1280 || options.branch) {
        assert.equal(await p.locator(".personal-mobile-footer").count(),0);
        assert.ok((await p.locator(".portal-tabs button:visible").count())>1);
      } else {
        await p.getByRole("button",{name:"Mehr Weitere Bereiche"}).click();
        await p.locator("#leadershipMoreView.active").waitFor();
        for(const tab of ["branchOrders","leadershipApprovals","timeTracking","schedule"])
          assert.equal(await p.locator(`[data-more-tab="${tab}"]`).isVisible(),false,tab);
        assert.equal(await p.locator("#mobileHomeTab").isVisible(),true);
      }
    } finally {await f.close();}
  }
});
