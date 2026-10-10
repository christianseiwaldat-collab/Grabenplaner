'use strict';
const Pdf = require('../../public/gp-price-label-pdf');
const Existing = require('../../public/gp-existing-pdf-window');

// The real domain and request adapters run against a small window lifecycle.
// Physical PDF bytes/layout are checked in the renderer integration suites.
function install(document) {
  const prints = [], win = document.defaultView ||= {};
  win.GpPriceLabelPdf = Pdf; win.GpExistingPdfWindow = Existing;
  win.location = {origin:'https://gp.example'};
  win.GpPrintWindow = {mount(config) {
    let payload=null, actor=String(config.key()), opened=false, enabled=true, abort=null, serial=0, pending=null, result=null, error=null;
    const cancel = () => {serial++;abort?.abort();abort=null;pending=null;result=null;};
    const usable = () => enabled && config.active() && config.canUse();
    const controller = {
      config, element:{},
      open(input) {this.reset();payload=input.payload;actor=String(config.key());opened=true;enabled=true;void this.refresh();return true;},
      reset() {cancel();payload=null;opened=false;error=null;},
      sync() {if(String(config.key())!==actor||!config.canUse()){actor=String(config.key());this.reset();return false;}return true;},
      activate() {enabled=true;this.sync();if(opened&&usable()&&!pending&&!result)void this.refresh();},
      deactivate() {enabled=false;cancel();},
      destroy() {this.reset();},
      async refresh() {
        if(!opened||!usable())return false;
        cancel();const ticket=serial,owner=actor,request=new AbortController();abort=request;
        const current = () => opened&&usable()&&serial===ticket&&!request.signal.aborted&&owner===String(config.key());
        const input={payload,actor:owner,signal:request.signal,values:config.defaults(payload),options:{}};
        pending=Promise.resolve().then(()=>config.createPdf(input)).then(value=>{if(current())result=value;return current();},reason=>{if(current())error=reason;return false;});
        const task=pending;await task;if(pending===task)pending=null;return Boolean(result);
      },
      get state(){return {payload,opened,active:usable(),result,error,signal:abort?.signal,pending};},
    };
    prints.push(controller);return controller;
  }};
  return prints;
}
module.exports={install};
