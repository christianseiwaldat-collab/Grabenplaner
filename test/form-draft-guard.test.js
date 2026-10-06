'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {create} = require('../public/form-draft-guard');
function fixture() {
  const listeners = {}, nodes = {};
  const root = {addEventListener: (k,f) => listeners[k] = f, removeEventListener() {},
    ownerDocument: {getElementById: id => nodes[id]}, contains: n => nodes[n.id] === n};
  const guard = create(root);
  const input = (id, type = 'text') => nodes[id] = {id,type,tagName:'INPUT',value:'',checked:false,disabled:false};
  const edit = (n,v) => { n.value = v; listeners.input({target:n}); };
  return {guard,input,edit};
}
test('rerender retains user settings; edits after submitting remain dirty', () => {
  const {guard,input,edit} = fixture(), a = input('setting');
  edit(a,'sent'); const sent = guard.snapshot(); edit(a,'later');
  a.value = 'server'; guard.acknowledge(sent); guard.restore(); assert.equal(a.value,'later');
  guard.acknowledge(guard.snapshot()); a.value = 'saved'; guard.restore(); assert.equal(a.value,'saved');
});
test('passwords and file inputs are excluded and account reset clears drafts', () => {
  const {guard,input,edit} = fixture(), a = input('setting'), p = input('password','password'), f = input('file','file');
  edit(a,'draft'); edit(p,'secret'); edit(f,'blob'); assert.equal(guard.snapshot().size,1);
  guard.clear(); a.value = 'other account'; guard.restore(); assert.equal(a.value,'other account');
});
test('newly disabled controls are not restored', () => {
  const {guard,input,edit} = fixture(), a=input('setting'); edit(a,'draft'); a.disabled=true; a.value='readonly';
  guard.restore(); assert.equal(a.value,'readonly'); assert.equal(guard.snapshot().size,0);
});
