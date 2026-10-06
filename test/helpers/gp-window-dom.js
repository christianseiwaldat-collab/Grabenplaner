'use strict';
function surface() {
  const listeners=new Map();
  return {addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);},
    removeEventListener(type,fn){listeners.get(type)?.delete(fn);},
    emit(type,options={}){
      const event={type,target:this,button:0,pointerId:1,isPrimary:true,clientX:0,clientY:0,
        preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...options};
      let node=this.ownerDocument?event.target:this;
      while(node) {for(const fn of node._listeners?.get(type) || (node===this?listeners.get(type):[]) || []) fn(event);if(event.stopped)break;node=node.parent;}
      return event;
    },_listeners:listeners};
}
function documentFixture() {
  const win=surface(),doc={...surface(),defaultView:win,activeElement:null};win.visualViewport=surface();win.innerWidth=1600;win.innerHeight=1000;
  function element(tag='div',attributes={},parent=null) {
    const classes=new Set(),attrs={...attributes},captures=new Set();
    const node={...surface(),tagName:tag.toUpperCase(),nodeType:1,ownerDocument:doc,parent,children:[],hidden:false,offsetHeight:44,textContent:'',
      style:{removeProperty(key){delete this[key];}},get parentElement(){return this.parent;},
      classList:{add(...values){values.forEach(v=>classes.add(v));},remove(...values){values.forEach(v=>classes.delete(v));},contains:v=>classes.has(v),toggle(v,on){if(on)classes.add(v);else classes.delete(v);}},
      hasAttribute:key=>Object.hasOwn(attrs,key),setAttribute(key,value){attrs[key]=String(value);},getAttribute:key=>attrs[key]??null,
      removeAttribute(key){delete attrs[key];},
      matches(selector){return selector.split(',').some(item=>{const value=item.trim();if(value.startsWith('[')){const match=value.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);return match && node.hasAttribute(match[1]) && (match[2]===undefined || node.getAttribute(match[1])===match[2]);}if(value.startsWith('.'))return classes.has(value.slice(1));return node.tagName===value.toUpperCase();});},
      closest(selector){for(let p=this;p;p=p.parent)if(p.matches?.(selector))return p;return null;},
      contains(candidate){for(let p=candidate;p;p=p.parent)if(p===this)return true;return false;},
      focus(){doc.activeElement=this;},setPointerCapture(id){captures.add(id);},hasPointerCapture:id=>captures.has(id),releasePointerCapture(id){captures.delete(id);},
      append(...values){for(const child of values){child.remove?.();child.parent=this;this.children.push(child);}},prepend(...values){for(const child of values.reverse()){child.remove?.();child.parent=this;this.children.unshift(child);}},
      remove(){if(this.parent?.children)this.parent.children=this.parent.children.filter(item=>item!==this);this.parent=null;},
      querySelector(selector){return this.querySelectorAll(selector)[0] || null;},
      querySelectorAll(selector){const result=[];for(const child of this.children){if(child.matches(selector))result.push(child);result.push(...child.querySelectorAll(selector));}return result;},
      getBoundingClientRect(){return {left:parseFloat(this.style.left)||0,top:parseFloat(this.style.top)||0,width:parseFloat(this.style.width)||560,height:parseFloat(this.style.height)||420};}};
    Object.defineProperty(node,'className',{get(){return [...classes].join(' ');},set(value){classes.clear();String(value).split(/\s+/).filter(Boolean).forEach(item=>classes.add(item));}});
    node.dataset=new Proxy({}, {set(_,key,value){node.setAttribute('data-'+String(key).replace(/[A-Z]/g,c=>'-'+c.toLowerCase()),value);return true;},get(_,key){return node.getAttribute('data-'+String(key).replace(/[A-Z]/g,c=>'-'+c.toLowerCase()));}});
    if(parent)parent.append(node);return node;
  }
  doc.createElement=tag=>element(tag);doc.body=element('body');doc.documentElement=element('html');doc.documentElement.append(doc.body);
  doc.querySelectorAll=selector=>doc.documentElement.querySelectorAll(selector);
  return {win,doc,element};
}
module.exports={surface,documentFixture};
