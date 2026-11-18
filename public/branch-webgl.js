(function(root,factory){'use strict';const common=typeof module==='object'&&module.exports;
  const api=factory(common?require('./branch-webgl-scene'):root.GrabenplanerBranchScene,
    common?require('./branch-webgl-map'):root.GrabenplanerBranchMap,
    common?require('./branch-webgl-materials'):root.GrabenplanerBranchMaterials);
  if(common)module.exports=api;else root.GrabenplanerBranchWebgl=api;
}(globalThis,function(Scene,MapView,Materials){
  'use strict';
  const initialCamera=()=>({yaw:3.65,pitch:.72,distance:30});
  const boundedCamera=c=>({...c,yaw:Number.isFinite(c.yaw)?c.yaw:3.65,
    pitch:Math.max(.08,Math.min(1.54,c.pitch)),distance:Math.max(2.5,Math.min(150,c.distance))});
  function multiply(a,b){const out=new Float32Array(16);for(let col=0;col<4;col++)for(let row=0;row<4;row++)for(let k=0;k<4;k++)out[col*4+row]+=a[k*4+row]*b[col*4+k];return out;}
  function projection(eye,target,aspect,fov){
    const normal=v=>{const n=Math.hypot(...v);return v.map(x=>x/n);},cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],dot=(a,b)=>a.reduce((n,v,i)=>n+v*b[i],0);
    const z=normal(eye.map((v,i)=>v-target[i])),x=normal(cross([0,1,0],z)),y=cross(z,x);
    const view=[x[0],y[0],z[0],0,x[1],y[1],z[1],0,x[2],y[2],z[2],0,-dot(x,eye),-dot(y,eye),-dot(z,eye),1];
    const near=.05,far=400,f=1/Math.tan(fov/2),a=Math.max(.1,aspect);
    return multiply([f/a,0,0,0,0,f,0,0,0,0,(far+near)/(near-far),-1,0,0,2*far*near/(near-far),0],view);
  }
  function viewProjection(camera,aspect,target=[0,0,0]){
    const c=boundedCamera(camera),d=c.distance,a=Math.max(.1,aspect);
    const eye=[target[0]+d*Math.cos(c.pitch)*Math.sin(c.yaw),target[1]+d*Math.sin(c.pitch),target[2]+d*Math.cos(c.pitch)*Math.cos(c.yaw)];
    const preset=Number.isFinite(c.fieldOfView)?c.fieldOfView*Math.PI/180:0;
    const fov=preset?2*Math.atan(Math.tan(preset/2)*Math.max(1,1.8/a)):Math.PI/3;
    return projection(eye,target,a,fov);
  }
  function walkProjection(player,aspect){const eye=[player.x,1.55,player.z],direction=[-Math.sin(player.yaw)*Math.cos(player.pitch),Math.sin(player.pitch),-Math.cos(player.yaw)*Math.cos(player.pitch)],fov=Number.isFinite(player.fieldOfView)?Math.max(35,Math.min(90,player.fieldOfView)):70;return projection(eye,eye.map((v,i)=>v+direction[i]),aspect,Math.PI*fov/180);}

  function renderSize(width,height,pixelRatio,limit) {
    width=Math.max(1,width);
    height=Math.max(1,height);
    const maxPixels=4_500_000;
    const scale=Math.min(2,Math.max(1.5,pixelRatio||1),Math.sqrt(maxPixels/(width*height)),limit/width,limit/height);
    return [Math.max(1,Math.floor(width*scale)),Math.max(1,Math.floor(height*scale))];
  }

  const horizon = [.74,.82,.865];
  const skyVertex=`
    attribute vec2 position;
    uniform vec3 forward;
    uniform vec3 screenRight;
    uniform vec3 screenUp;
    varying mediump vec3 ray;
    void main(){
      ray=forward+position.x*screenRight+position.y*screenUp;
      gl_Position=vec4(position,1.0,1.0);
    }`;
  const skyFragment=`
    precision mediump float;
    varying mediump vec3 ray;
    void main(){
      vec3 direction=normalize(ray);
      float height=smoothstep(0.0,0.62,direction.y);
      vec3 gradient=mix(vec3(${horizon.join(',')}),vec3(0.32,0.57,0.75),height);
      float glow=pow(max(0.0,dot(direction,vec3(-0.43,0.52,0.74))),12.0);
      gl_FragColor=vec4(gradient+glow*vec3(0.105,0.075,0.035),1.0);
    }`;
  const colorVertex=`
    attribute vec3 position;
    attribute vec4 color;
    uniform mat4 matrix;
    varying mediump vec4 tint;
    varying mediump float depth;
    void main(){
      tint=color;
      gl_Position=matrix*vec4(position,1.0);
      depth=gl_Position.w;
    }`;
  const materialVertex=`
    attribute vec3 position;
    attribute vec2 uv;
    uniform mat4 matrix;
    varying mediump vec2 tex;
    varying mediump float depth;
    void main(){
      tex=uv;
      gl_Position=matrix*vec4(position,1.0);
      depth=gl_Position.w;
    }`;
  const fog=`vec3 distanceTint(vec3 base, float z){
    return mix(base, vec3(${horizon.join(',')}), smoothstep(48.0, 224.0, z));
  }`;
  const colorFragment=`
    precision mediump float;
    varying mediump vec4 tint;
    varying mediump float depth;
    ${fog}
    void main(){gl_FragColor=vec4(distanceTint(tint.rgb,depth),tint.a);}`;
  const materialFragment=`
    precision mediump float;
    uniform sampler2D image;
    uniform bool mirrorBack;
    varying mediump vec2 tex;
    varying mediump float depth;
    ${fog}
    void main(){
      vec2 t=vec2(mirrorBack && !gl_FrontFacing ? 1.0-tex.x : tex.x,tex.y);
      vec4 pixel=texture2D(image,t);
      if(pixel.a<0.02) discard;
      gl_FragColor=vec4(distanceTint(pixel.rgb,depth),pixel.a);
    }`;

  function mount(root){
    const canvas=root.querySelector('canvas'),status=root.querySelector('[data-webgl-status]'),fallback=root.querySelector('[data-webgl-fallback]');
    const stage=root.querySelector('.branch-webgl-stage'),dot=root.querySelector('[data-webgl-crosshair]'),walkControls=root.querySelector('[data-webgl-walk-controls]'),mapNode=root.querySelector('[data-webgl-map]');
    const doc=root.ownerDocument,win=doc.defaultView,scene=Scene.create();
    let active=false,destroyed=false,gl=null,colorProgram=null,textureProgram=null,skyProgram=null,frame=0,last=0,drag=null,lost=false,mode='overview',camera=initialCamera(),target=[7,0,6],player=Scene.spawn(),mapWorkspace=null;
    const keys=new Set(),disposers=[],buffers=[],textures=[],parts={},labelParts=[],surfaceParts=[];
    let anisotropic=null,renderLimit=4096;
    const walking=()=>['KeyW','KeyA','KeyS','KeyD'].some(key=>keys.has(key));
    function listen(object,type,fn,options){object.addEventListener(type,fn,options);disposers.push(()=>object.removeEventListener(type,fn,options));}
    function announce(text){status.textContent=text;}
    function controls(enabled){for(const button of root.querySelectorAll('[data-webgl-action]'))button.disabled=!enabled&&!['map','in','out','fullscreen'].includes(button.dataset.webglAction);}
    function clearInput(){keys.clear();last=0;}
    function freeMouse(){clearInput();if(doc.pointerLockElement===canvas)doc.exitPointerLock();}
    function endDrag(){if(drag&&canvas.hasPointerCapture?.(drag.id))canvas.releasePointerCapture(drag.id);drag=null;}
    function release(){if(gl){for(const b of buffers)gl.deleteBuffer(b);for(const t of textures)gl.deleteTexture(t);for(const p of [colorProgram,textureProgram,skyProgram])if(p)gl.deleteProgram(p);}buffers.length=textures.length=labelParts.length=surfaceParts.length=0;colorProgram=textureProgram=skyProgram=null;}
    function program(vertex,fragment){
      const result=gl.createProgram(),shaders=[];try{for(const[type,source]of[[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]){const shader=gl.createShader(type);shaders.push(shader);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error('Shader failed');gl.attachShader(result,shader);}gl.linkProgram(result);if(!gl.getProgramParameter(result,gl.LINK_STATUS))throw Error('Program failed');return result;}catch(error){gl.deleteProgram(result);throw error;}finally{for(const shader of shaders)gl.deleteShader(shader);}
    }
    function upload(vertices,stride){const buffer=gl.createBuffer();buffers.push(buffer);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,vertices,gl.STATIC_DRAW);return {buffer,count:vertices.length/stride};}
    function texture(source, repeat = false) {
      const value=gl.createTexture();
      textures.push(value);
      gl.bindTexture(gl.TEXTURE_2D,value);
      if (ArrayBuffer.isView(source)) {
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,Materials.size,Materials.size,0,gl.RGBA,gl.UNSIGNED_BYTE,source);
      } else {
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);
      }
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      const wrap=repeat?gl.REPEAT:gl.CLAMP_TO_EDGE;
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,wrap);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,wrap);
      if(repeat&&anisotropic) {
        const level=Math.min(8,gl.getParameter(anisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT));
        gl.texParameterf(gl.TEXTURE_2D,anisotropic.TEXTURE_MAX_ANISOTROPY_EXT,level);
      }
      return value;
    }
    function surfaceTexture(material) {
      if(Object.hasOwn(Materials.surfaces,material)) return texture(Materials.pixels(material),true);
      const paper=doc.createElement('canvas');
      paper.width=paper.height=512;
      Materials.fineArt(paper.getContext('2d'),material==='fine-art-mono');
      return texture(paper);
    }
    function labelTexture(label){
      const surface=doc.createElement('canvas');surface.width=label.vertical?256:1024;surface.height=label.vertical?1024:128;
      const ctx=surface.getContext('2d'),w=surface.width,h=surface.height;
      if(label.theme==='canon'||label.theme==='model'){
        ctx.textAlign='center';
        ctx.textBaseline='middle';
        ctx.fillStyle=label.theme==='canon'?'#f4f4f1':'#dedfdf';
        ctx.font=label.theme==='canon'?'bold 102px Georgia':'bold 76px Arial';
        ctx.fillText(label.text,w/2,h/2,w*.88);
        return texture(surface);
      }
      if(label.theme==='printer-screen'){
        ctx.fillStyle='#173943';ctx.fillRect(0,0,w,h);
        ctx.fillStyle='#6399a5';ctx.fillRect(32,14,960,25);
        ctx.fillStyle='#d2e1df';ctx.fillRect(44,60,214,43);
        ctx.fillStyle='#9ec8c7';
        for(let i=0;i<4;i+=1)ctx.fillRect(334+i*155,76,82,12);
        return texture(surface);
      }
      ctx.fillStyle=label.theme==='red'?'#c6192d':label.theme==='white'?'#f6f5f0':'#171a1c';ctx.fillRect(0,0,w,h);
      ctx.fillStyle=label.theme==='white'?'#111':'#fff';ctx.textAlign='center';ctx.textBaseline='middle';
      if(label.vertical){ctx.translate(w/2,h/2);ctx.rotate(-Math.PI/2);ctx.font='bold 100px Arial';ctx.fillText(label.text,0,0,h-70);}
      else if(label.theme==='brand'){const words=label.text.split('|');ctx.fillStyle='#c6192d';ctx.fillRect(w*.36,0,w*.64,h);ctx.fillStyle='#fff';ctx.font='bold 57px Arial';ctx.fillText(words[0].trim(),w*.18,h/2,w*.33);ctx.fillText((words[1]||'').trim(),w*.68,h/2,w*.60);}
      else{ctx.font='bold 70px Arial';ctx.fillText(label.text,w/2,h/2,w-45);}
      return texture(surface);
    }
    function initialize(){
      try{
        gl=canvas.getContext('webgl',{alpha:false,antialias:true});if(!gl)throw Error('WebGL unavailable');
        anisotropic=gl.getExtension('EXT_texture_filter_anisotropic');
        renderLimit=Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),...gl.getParameter(gl.MAX_VIEWPORT_DIMS));
        colorProgram=program(colorVertex,colorFragment);
        textureProgram=program(materialVertex,materialFragment);
        skyProgram=program(skyVertex,skyFragment);
        parts.sky=upload(new Float32Array([-1,-1,3,-1,-1,3]),2);
        for(const name of['opaque','glass','ceiling','lines','shadows'])parts[name]=upload(scene[name],7);
        for(const {material,vertices} of scene.surfaces) {
          surfaceParts.push({...upload(vertices,5),texture:surfaceTexture(material)});
        }
        const cache=new Map();for(const label of scene.labels){const key=[label.text,label.theme,label.vertical].join('|');if(!cache.has(key))cache.set(key,labelTexture(label));
          const vertices=[],uvs=[[0,1],[1,1],[1,0],[0,0]];for(const i of[0,1,2,0,2,3])vertices.push(...label.points[i],...uvs[i]);labelParts.push({...upload(new Float32Array(vertices),5),texture:cache.get(key)});
        }
        fallback.hidden=true;canvas.hidden=mode==='map';controls(true);if(mode!=='map')announce('Übersicht · Filiale 18 · Proportionsmodell, Maße noch unbestätigt');return true;
      }catch{release();controls(false);fallback.hidden=mode==='map';canvas.hidden=true;if(mode!=='map')announce('WebGL steht in diesem Browser nicht zur Verfügung. Die Planungsgrundlagen bleiben sichtbar.');return false;}
    }
    function colored(part,matrix,primitive){
      gl.useProgram(colorProgram);gl.bindBuffer(gl.ARRAY_BUFFER,part.buffer);
      for(const[name,size,offset]of[['position',3,0],['color',4,12]]){const at=gl.getAttribLocation(colorProgram,name);gl.enableVertexAttribArray(at);gl.vertexAttribPointer(at,size,gl.FLOAT,false,28,offset);}
      gl.uniformMatrix4fv(gl.getUniformLocation(colorProgram,'matrix'),false,matrix);gl.drawArrays(primitive,0,part.count);
    }
    function textured(collection,matrix,mirrorBack){
      gl.useProgram(textureProgram);
      gl.uniformMatrix4fv(gl.getUniformLocation(textureProgram,'matrix'),false,matrix);
      gl.uniform1i(gl.getUniformLocation(textureProgram,'image'),0);
      gl.uniform1i(gl.getUniformLocation(textureProgram,'mirrorBack'),mirrorBack?1:0);
      for(const part of collection){
        gl.bindTexture(gl.TEXTURE_2D,part.texture);gl.bindBuffer(gl.ARRAY_BUFFER,part.buffer);
        for(const[name,size,offset]of[['position',3,0],['uv',2,12]]){
          const slot=gl.getAttribLocation(textureProgram,name);
          gl.enableVertexAttribArray(slot);gl.vertexAttribPointer(slot,size,gl.FLOAT,false,20,offset);
        }
        gl.drawArrays(gl.TRIANGLES,0,part.count);
      }
    }
    function drawSky(matrix) {
      // The view-projection rows carry the camera basis with its horizontal
      // and vertical focal lengths. Their scaled inverses give world rays.
      const axis = row => {
        const vector = [matrix[row],matrix[row+4],matrix[row+8]];
        const scale = vector.reduce((length,value)=>length+value*value,0);
        return vector.map(value=>value/scale);
      };
      gl.depthFunc(gl.LEQUAL);
      gl.useProgram(skyProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER,parts.sky.buffer);
      const position=gl.getAttribLocation(skyProgram,'position');
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
      gl.uniform3fv(gl.getUniformLocation(skyProgram,'forward'),[matrix[3],matrix[7],matrix[11]]);
      gl.uniform3fv(gl.getUniformLocation(skyProgram,'screenRight'),axis(0));
      gl.uniform3fv(gl.getUniformLocation(skyProgram,'screenUp'),axis(1));
      gl.drawArrays(gl.TRIANGLES,0,parts.sky.count);
      gl.depthFunc(gl.LESS);
    }
    function draw(at){
      frame=0;if(!active||destroyed||lost||doc.hidden||mode==='map'||!gl||!colorProgram)return;
      if(mode==='walk'&&walking()){const seconds=last?Math.min(.05,(at-last)/1000):.016;player=Scene.move(scene,player,(keys.has('KeyD')?1:0)-(keys.has('KeyA')?1:0),(keys.has('KeyW')?1:0)-(keys.has('KeyS')?1:0),seconds,keys.has('ShiftLeft')||keys.has('ShiftRight'));}last=at;
      const bounds=canvas.getBoundingClientRect(),[width,height]=renderSize(bounds.width,bounds.height,win.devicePixelRatio,renderLimit);
      if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
      const matrix=mode==='walk'?walkProjection(player,width/height):viewProjection(camera,width/height,target);
      gl.viewport(0,0,width,height);gl.clearColor(...horizon,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.enable(gl.DEPTH_TEST);gl.disable(gl.CULL_FACE);gl.disable(gl.BLEND);gl.depthMask(true);
      colored(parts.opaque,matrix,gl.TRIANGLES);
      if(mode==='walk')colored(parts.ceiling,matrix,gl.TRIANGLES);
      textured(surfaceParts,matrix,false);
      colored(parts.lines,matrix,gl.LINES);
      drawSky(matrix);
      gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.depthMask(false);
      colored(parts.shadows,matrix,gl.TRIANGLES);
      textured(labelParts,matrix,true);
      colored(parts.glass,matrix,gl.TRIANGLES);
      gl.depthMask(true);gl.disable(gl.BLEND);
      if(mode==='walk'&&walking())schedule();
    }
    function schedule(){if(active&&!frame&&!destroyed&&!doc.hidden)frame=win.requestAnimationFrame(draw);}
    function setMode(next,preset=''){
      freeMouse();endDrag();mapWorkspace?.suspend();mode=next;if(dot)dot.hidden=mode!=='walk';if(walkControls)walkControls.hidden=mode!=='walk';
      if(mapNode)mapNode.hidden=mode!=='map';canvas.hidden=mode==='map'||!colorProgram;if(mode==='map')fallback.hidden=true;
      root.dataset.webglMode=mode;root.dataset.webglPreset=preset;for(const button of root.querySelectorAll('[data-webgl-action="walk"],[data-webgl-action="map"]'))button.setAttribute('aria-pressed',String(mode===button.dataset.webglAction));
      announce(mode==='map'?'Lageplan · Ziehen zum Verschieben · Mausrad oder +/− zum Zoomen · erneuter Klick auf Lageplan setzt die Karte zurück':mode==='walk'?'Ich-Perspektive · WASD gehen · Klick in die Ansicht für Mausblick · Esc gibt die Maus frei':'Übersicht · Ziehen zum Drehen · Mausrad zum Zoomen');schedule();
    }
    function step(right,forward){const before=player;for(let i=0;i<4;i++)player=Scene.move(scene,player,right,forward,.1);announce(Math.hypot(player.x-before.x,player.z-before.z)<.01?'Durchgang blockiert · Wand oder Einrichtung':'Schritt '+(forward>0?'vorwärts':forward<0?'zurück':right>0?'nach rechts':'nach links')+' · '+(Scene.contains(player.x,player.z)?'Verkaufsraum':'Außenbereich'));schedule();}
    listen(root,'click',event=>{
      if(!active)return;const action=event.target.closest('[data-webgl-action]')?.dataset.webglAction;
      if(action==='map'&&mapNode&&MapView){if(!mapWorkspace)mapWorkspace=MapView.mount(mapNode);else mapWorkspace.reset();setMode('map');return;}
      if(action==='fullscreen'){stage?.requestFullscreen?.().catch(()=>announce('Vollbild ist nicht verfügbar. Die Ansicht funktioniert eingebettet.'));return;}
      if(mode==='map'&&(action==='in'||action==='out')){mapWorkspace?.zoom(action==='in'?1.2:1/1.2);return;}
      if(!colorProgram)return;
      if(action==='walk'){setMode('walk');canvas.focus({preventScroll:true});}
      if(action==='outside'){player={...Scene.entranceView(10),fieldOfView:45};setMode('walk');announce('Ich-Perspektive · 10 Modellmeter vor dem Eingang · Augenhöhe 1,55 m · engerer Bildausschnitt mit 45° Blickfeld');canvas.focus({preventScroll:true});}
      if(action==='street'){player=Scene.streetView();setMode('walk','street');announce('Blick vom Grabenweg Richtung Süden · Fassade und Umgebung als Proportionsmodell');canvas.focus({preventScroll:true});}
      if(action==='reset'){camera=initialCamera();target=[7,0,6];setMode('overview');}
      if(action==='building'){camera={yaw:3.6,pitch:.9,distance:104};target=[6,0,29];setMode('overview');}
      if(action==='fotowelt'){({camera,target}=Scene.fotoweltView());setMode('overview','fotowelt');announce('Fotowelt · Zwei Canon imagePROGRAF PRO-2000 · Aufstellung vorläufig');}
      if(action==='top'){setMode('overview');camera={...camera,yaw:Math.PI,pitch:1.54};schedule();}
      if(action==='spawn'){player=Scene.spawn();setMode('walk');canvas.focus({preventScroll:true});}
      if(action==='in'||action==='out'){if(mode==='walk')step(0,action==='in'?1:-1);else{camera=boundedCamera({...camera,distance:camera.distance*(action==='in'? 0.85:1.15)});schedule();}}
      if(action==='forward')step(0,1);if(action==='back')step(0,-1);if(action==='left')step(-1,0);if(action==='right')step(1,0);
      if(action==='turn-left'||action==='turn-right'){player.yaw+=action==='turn-left'? 0.18:-.18;schedule();}
    });
    listen(canvas,'click',()=>{if(!active||mode!=='walk'||doc.pointerLockElement===canvas)return;canvas.focus({preventScroll:true});try{const result=canvas.requestPointerLock?.();result?.catch?.(()=>announce('Mausblick nicht freigegeben · zum Umschauen ziehen; WASD funktioniert weiterhin.'));}catch{announce('Zum Umschauen ziehen · WASD zum Gehen');}});
    listen(canvas,'pointerdown',event=>{if(!active||event.button!==0||doc.pointerLockElement===canvas)return;drag={id:event.pointerId,x:event.clientX,y:event.clientY};canvas.setPointerCapture(event.pointerId);canvas.focus({preventScroll:true});});
    function look(dx,dy){player={...player,yaw:player.yaw-dx*.0022,pitch:Math.max(-1.45,Math.min(1.45,player.pitch-dy*.0022))};schedule();}
    listen(canvas,'pointermove',event=>{if(!active||!drag||drag.id!==event.pointerId)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;if(mode==='walk')look(dx,dy);else{camera=boundedCamera({...camera,yaw:camera.yaw-dx*.008,pitch:camera.pitch+dy*.008});schedule();}drag.x=event.clientX;drag.y=event.clientY;});
    listen(doc,'mousemove',event=>{if(active&&mode==='walk'&&doc.pointerLockElement===canvas)look(event.movementX,event.movementY);});
    listen(canvas,'pointerup',endDrag);listen(canvas,'pointercancel',endDrag);listen(canvas,'lostpointercapture',()=>{drag=null;});
    listen(doc,'pointerlockchange',()=>{endDrag();clearInput();if(doc.pointerLockElement!==canvas&&mode==='walk'&&active)announce('Maus frei · Klick in die Ansicht setzt den Mausblick fort');});
    listen(canvas,'wheel',event=>{if(!active||mode==='walk')return;event.preventDefault();camera=boundedCamera({...camera,distance:camera.distance*Math.exp(Math.max(-100,Math.min(100,event.deltaY))*.002)});schedule();},{passive:false});
    listen(doc,'keydown',event=>{
      if(!active||event.ctrlKey||event.metaKey||event.altKey||event.isComposing)return;
      const owns=doc.activeElement===canvas||doc.pointerLockElement===canvas;if(!owns)return;
      if(event.code==='Escape'||event.key==='Escape'){clearInput();freeMouse();endDrag();return;}
      if(mode==='walk'&&['KeyW','KeyA','KeyS','KeyD','ShiftLeft','ShiftRight'].includes(event.code)){event.preventDefault();keys.add(event.code);schedule();}
      if(mode==='walk'&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();if(event.key==='ArrowLeft')player.yaw+=.12;if(event.key==='ArrowRight')player.yaw-=.12;if(event.key==='ArrowUp')step(0,1);if(event.key==='ArrowDown')step(0,-1);schedule();}
    });
    listen(doc,'keyup',event=>{keys.delete(event.code);if(!keys.size)last=0;});
    listen(win,'blur',()=>{freeMouse();endDrag();mapWorkspace?.suspend();});
    listen(doc,'visibilitychange',()=>{if(doc.hidden){freeMouse();endDrag();mapWorkspace?.suspend();}else schedule();});
    listen(canvas,'webglcontextlost',event=>{event.preventDefault();lost=true;freeMouse();controls(false);fallback.hidden=false;announce('3D-Ansicht unterbrochen. Sie wird nach Wiederherstellung der Grafik neu aufgebaut.');});
    listen(canvas,'webglcontextrestored',()=>{lost=false;buffers.length=textures.length=labelParts.length=surfaceParts.length=0;colorProgram=textureProgram=skyProgram=null;if(initialize())schedule();});
    const observer=win.ResizeObserver?new win.ResizeObserver(schedule):null;if(!observer)listen(win,'resize',schedule);
    return {
      activate(){if(destroyed)return;active=true;observer?.observe(canvas);if(!gl&&!initialize())return;schedule();},
      suspend(){active=false;freeMouse();endDrag();mapWorkspace?.suspend();observer?.disconnect();if(frame)win.cancelAnimationFrame(frame);frame=0;if(doc.fullscreenElement&&stage?.contains(doc.fullscreenElement))doc.exitFullscreen?.();},
      destroy(){this.suspend();destroyed=true;mapWorkspace?.destroy();for(const dispose of disposers)dispose();release();},
    };
  }
  return Object.freeze({mount,initialCamera,boundedCamera,viewProjection,walkProjection,renderSize});
}));
