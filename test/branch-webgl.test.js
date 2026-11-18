'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const Webgl=require('../public/branch-webgl'),Sidebar=require('../public/sidebar-layout');
const {functionSource,section,read}=require('../test-support/learning-workspace-ui');

test('the Grabenweg page follows branch navigation and requires the existing team scope and an active Grabenweg location',()=>{
 assert.deepEqual(Sidebar.navigationPath('branchWebgl'),['filialManagement']);
 let allowed=true,locations=[{name:'Grabenweg'}];
 const context=vm.createContext({canAccessTeamManagement:()=>allowed,activeLocations:()=>locations});
 vm.runInContext(functionSource('canOpenBranchWebgl'),context);
 assert.equal(context.canOpenBranchWebgl(),true);allowed=false;assert.equal(context.canOpenBranchWebgl(),false);
 allowed=true;locations=[{name:'Andere Filiale'}];assert.equal(context.canOpenBranchWebgl(),false);
 const page=section('branchWebglView');assert.match(page,/Maßstab, Höhe und Möbelpositionen vorläufig/);assert.match(page,/noch nicht vermessen/);
 assert.match(read('index.html'),/data-view="branchWebgl"/);
});

test('traced concave footprint triangulates without changing its area and keeps all model dimensions explicitly provisional',()=>{
 const S=require('../public/branch-webgl-scene'),model=S.create(),p=S.footprint;
 const area=Math.abs(p.reduce((sum,a,i)=>{const b=p[(i+1)%p.length];return sum+a[0]*b[1]-b[0]*a[1];},0))/2;
 const triangles=S.triangulate(p),covered=triangles.reduce((n,[i,j,k])=>n+Math.abs((p[j][0]-p[i][0])*(p[k][1]-p[i][1])-(p[j][1]-p[i][1])*(p[k][0]-p[i][0]))/2,0);
 assert.ok(Math.abs(area-covered)<1e-7);assert.equal(triangles.length,p.length-2);
 for(const name of ['opaque','glass','ceiling','lines'])assert.ok([...model[name]].every(Number.isFinite),name);
 assert.equal(model.assumptions.scaleVerified,false);assert.equal(model.assumptions.interiorLayoutVerified,false);assert.equal(model.assumptions.heightVerified,false);
});

test('walking passes through the entrance while solid walls and furnishing stop swept movement',()=>{
 const S=require('../public/branch-webgl-scene'),model=S.create();let entrance=S.entranceView(2),wall={x:8,z:-2,yaw:Math.PI,pitch:0};
 for(let i=0;i<80;i++){entrance=S.move(model,entrance,0,1,.05);wall=S.move(model,wall,0,1,.05);}
 assert.ok(S.contains(entrance.x,entrance.z));assert.ok(entrance.x<S.entrance.center[0]-1);assert.ok(wall.z<-.24);
 let cabinet={...S.spawn(),x:6,z:3};for(let i=0;i<100;i++)cabinet=S.move(model,cabinet,0,1,.1,true);
 assert.ok(cabinet.z<4.36);assert.equal(S.blocked(model,S.spawn().x,S.spawn().z),false);
});

test('the exterior first-person preset stands ten model metres from the parking-side entrance and looks directly at it',()=>{
 const S=require('../public/branch-webgl-scene'),eye=S.entranceView(10),[x,z]=S.entrance.center;
 assert.ok(Math.abs(Math.hypot(eye.x-x,eye.z-z)-10)<1e-10);assert.equal(S.contains(eye.x,eye.z),false);assert.equal(S.entrance.positionVerified,false);
 const direction=[-Math.sin(eye.yaw),-Math.cos(eye.yaw)];assert.ok(direction[0]*(x-eye.x)+direction[1]*(z-eye.z)>9.999);
 assert.ok(!S.blocked(S.create(),eye.x,eye.z));assert.ok(eye.x>x);
 const wide=Webgl.walkProjection({...eye,yaw:0},1.6),close=Webgl.walkProjection({...eye,yaw:0,fieldOfView:45},1.6);assert.ok(close[0]>wide[0]);
 assert.ok(S.create().labels.some(label=>label.text==='EINGANG'));
});

test('the yellow shop boundary separates GP from Orion and keeps GP furniture on its own side',()=>{
 const S=require('../public/branch-webgl-scene'),model=S.create();
 const area=polygon=>Math.abs(polygon.reduce((n,a,i)=>{const b=polygon[(i+1)%polygon.length];return n+a[0]*b[1]-a[1]*b[0];},0))/2;
 assert.ok(Math.abs(area(model.footprint)+area(model.neighborFootprint)-area(model.buildingFootprint))<1e-7);
 assert.ok(area(model.footprint)<area(model.buildingFootprint)*.75);
 assert.ok(model.footprint.every(p=>p[1]<=model.tenancy.shopEnd));assert.ok(model.neighborFootprint.every(p=>p[1]>=model.tenancy.shopEnd));
 for(const fixture of model.obstacles){for(const x of[fixture.minX+.001,fixture.maxX-.001])for(const z of[fixture.minZ+.001,fixture.maxZ-.001])assert.ok(S.contains(x,z),fixture.id);}
 let walker={x:21.3,z:7.4,yaw:Math.PI,pitch:0};for(let i=0;i<60;i++)walker=S.move(model,walker,0,1,.1);
 assert.ok(walker.z<model.tenancy.shopEnd-.24);assert.ok(S.contains(walker.x,walker.z));assert.ok(model.labels.some(l=>l.text==='ORION'));
 assert.equal(model.assumptions.provisionalHeight,3.3);assert.equal(model.tenancy.dimensionsVerified,false);
});

test('the wider open sliding door admits an off-centre walker and the street viewpoint faces south',()=>{
 const S=require('../public/branch-webgl-scene'),model=S.create();let walker=S.entranceView(2);
 walker.x+=S.entrance.tangent[0]*1.05;walker.z+=S.entrance.tangent[1]*1.05;
 assert.equal(S.entrance.type,'sliding');assert.equal(S.entrance.state,'open');assert.ok(S.entrance.width>2.5);
 for(let i=0;i<55;i++)walker=S.move(model,walker,0,1,.05);
 assert.ok(S.contains(walker.x,walker.z));assert.ok(walker.x<S.entrance.center[0]-1);
 const street=S.streetView();assert.ok(street.z<0);assert.ok(-Math.cos(street.yaw)>.8);assert.ok(!S.blocked(model,street.x,street.z));
});

test('walking direction matches the OS mouse convention, diagonal input has no speed boost and long frames are bounded',()=>{
 const S=require('../public/branch-webgl-scene'),model=S.create(),start={x:-15,z:-8,yaw:0,pitch:0};
 const forward=S.move(model,start,0,1,.1),diagonal=S.move(model,start,1,1,.1);
 assert.ok(forward.z<start.z);assert.ok(Math.abs(Math.hypot(diagonal.x-start.x,diagonal.z-start.z)-Math.hypot(forward.x-start.x,forward.z-start.z))<1e-8);
 assert.deepEqual(S.move(model,start,0,1,100),forward);
 const rightTurn=S.move(model,{...start,yaw:-Math.PI/2},0,1,.1);assert.ok(rightTurn.x>start.x);
 for(const yaw of[0,.4,Math.PI,-1.2]){
  const player={...S.spawn(),yaw},matrix=Webgl.walkProjection(player,1.6),point=[player.x-Math.sin(yaw)*2,1.55,player.z-Math.cos(yaw)*2,1];
  const projected=[0,1,2,3].map(row=>point.reduce((n,v,i)=>n+matrix[i*4+row]*v,0));
  assert.ok(Math.abs(projected[0]/projected[3])<1e-5);assert.ok(Math.abs(projected[1]/projected[3])<1e-5);
 }
});

test('WebGL camera keeps the origin in view while zoom limits and top view remain finite',()=>{
 for(const camera of [Webgl.initialCamera(),Webgl.boundedCamera({yaw:-8,pitch:9,distance:0}),Webgl.boundedCamera({yaw:0,pitch:1.54,distance:65})]){
  for(const aspect of [0.3,1,2.4]){
   const matrix=Webgl.viewProjection(camera,aspect);assert.ok([...matrix].every(Number.isFinite));
   assert.ok(matrix[15]>0);assert.ok(Math.abs(matrix[12]/matrix[15])<1e-6);assert.ok(Math.abs(matrix[13]/matrix[15])<1e-6);
  }
 }
 const detail=require('../public/branch-webgl-scene').fotoweltView();
 assert.equal(Webgl.boundedCamera({...detail.camera,distance:detail.camera.distance*.85}).fieldOfView,detail.camera.fieldOfView);
});

test('the renderer supersamples ordinary viewports within the hardware and pixel budgets',()=>{
 assert.deepEqual(Webgl.renderSize(1031,520,2,4096),[2062,1040]);
 assert.deepEqual(Webgl.renderSize(800,520,1,4096),[1200,780]);
 const [width,height]=Webgl.renderSize(3840,2160,3,4096);
 assert.ok(width*height<=4_500_000);
 assert.ok(Math.abs(width/height-3840/2160)<.002);
 assert.deepEqual(Webgl.renderSize(2048,1024,2,1024),[1024,512]);
});

test('unsupported graphics gives an accessible fallback and suspension/destroy release the scheduled frame and listeners',()=>{
 const listeners=new Set(),status={textContent:''},fallback={hidden:true};let cancelled=0,queued=0;
 const events=()=>({addEventListener(type,fn){listeners.add(fn);},removeEventListener(type,fn){listeners.delete(fn);}});
 const win={...events(),requestAnimationFrame:()=>++queued,cancelAnimationFrame:()=>cancelled++};
 const doc={...events(),hidden:false,defaultView:win};
 const canvas={...events(),hidden:false,getContext:()=>null};
 const root={...events(),ownerDocument:doc,querySelectorAll:()=>[],querySelector:s=>s==='canvas'?canvas:s==='[data-webgl-status]'?status:s==='[data-webgl-fallback]'?fallback:null};
 const viewer=Webgl.mount(root);viewer.activate();assert.equal(fallback.hidden,false);assert.equal(canvas.hidden,true);
 assert.match(status.textContent,/nicht zur Verfügung/);assert.equal(queued,0);
 viewer.destroy();assert.equal(listeners.size,0);assert.equal(cancelled,0);
});

test('the two FineArt plotters use Canon dimensions and stop walking through their output baskets',()=>{
 const S=require('../public/branch-webgl-scene'),model=S.create();assert.equal(model.equipment.length,2);
 for(const printer of model.equipment){
  assert.equal(printer.model,'Canon imagePROGRAF PRO-2000');assert.deepEqual(printer.dimensions,{width:1.11,depth:.984,height:1.168});
  assert.equal(printer.placementVerified,false);const [x,,z]=printer.position;
  assert.equal(S.blocked(model,x+.5,z+.9),true);assert.equal(S.contains(x,z),true);
 }
 assert.ok(model.labels.some(label=>label.text.includes('FOTOWELT')));assert.ok(!model.labels.some(label=>label.text.includes('SONY')));
 const paper = model.surfaces.filter(surface=>surface.material.startsWith('fine-art-'));
 assert.deepEqual(paper.map(surface=>surface.material),['fine-art-colour','fine-art-mono']);
 for(const [i,{vertices}] of paper.entries()){
  const [x,,z]=model.equipment[i].position;
  const {width,depth,height}=model.equipment[i].dimensions;
  assert.ok(vertices.length>30&&vertices.length%30===0);
  const depths=new Set();
  let galleryVertices=0;
  for(let j=0;j<vertices.length;j+=5){
   const [px,py,pz,u,v]=vertices.subarray(j,j+5);
   assert.ok(u>=0&&u<=1&&v>=0&&v<=1);
   if(pz<.1){
    assert.ok(py>1.1&&py<1.6);
    galleryVertices+=1;
    continue;
   }
   assert.ok(px>=x&&px<=x+width&&py>0&&py<=height&&pz>=z&&pz<=z+depth);
   depths.add(pz);
  }
  assert.ok(depths.size>2);
  assert.equal(galleryVertices,6);
 }
});

test('exterior geometry uses separate repeatable high-resolution materials',()=>{
 const model=require('../public/branch-webgl-scene').create(),materials=require('../public/branch-webgl-materials');
 assert.equal(materials.size,512);
 for(const name of ['road','parking','pavers','concrete','grass','paint','facade']){
  const vertices=model.surfaces.find(surface=>surface.material===name).vertices;
  assert.ok(vertices.length>0&&vertices.length%15===0);
  assert.ok(vertices.every(Number.isFinite));
 }
 const asphalt=materials.pixels('road');
 assert.equal(asphalt.length,512*512*4);
 assert.ok(asphalt.some((value,index)=>index%4===0&&value!==asphalt[0]));
 const index=read('index.html'),order=['materials','plotter','scene','map-data','map'].map(name=>index.indexOf('/branch-webgl-'+name+'.js'));
 order.push(index.indexOf('/branch-webgl.js'));
 assert.ok(order.every((position,i)=>position>=0&&(i===0||position>order[i-1])));
});

test('painted parking bays contain their parked vehicles without blocking the approaches to the shop',()=>{
 const scene=require('../public/branch-webgl-scene'),model=scene.create();
 const vehicles=model.exteriorObstacles.filter(obstacle=>obstacle.kind==='car');
 assert.equal(vehicles.length,4);
 for(const vehicle of vehicles){
  const x=(vehicle.minX+vehicle.maxX)/2,z=(vehicle.minZ+vehicle.maxZ)/2;
  assert.ok(!scene.contains(x,z));
  assert.ok(scene.blocked(model,x,z));
  assert.ok(!scene.blocked(model,vehicle.maxX+.5,z));
 }
 for(const start of [scene.streetView(),scene.entranceView(10),scene.spawn()]){
  assert.ok(!scene.blocked(model,start.x,start.z));
 }
});

test('the local map contains the requested surrounding shops and roads, attributed source geometry and bounded zoom',()=>{
 const Map=require('../public/branch-webgl-map'),html=Map.markup();
 assert.deepEqual(Map.data.places.map(p=>p.name).sort(),['Greif Center','Hervis','JYSK','Lamprechter','Onkel Hasan','Orion'].sort());
 for(const name of ['Grabenweg','Andechsstraße','Amraser-See-Straße'])assert.ok(Map.data.roads.some(r=>r.name===name));
 assert.equal(Map.data.buildings.filter(b=>b.id==='47110371').length,1);
 assert.match(html,/© OpenStreetMap-Mitwirkende/);assert.match(html,/Fotowelt · FineArt-Druck/);
 assert.ok(!/<script|<foreignObject|<image/.test(html));
 assert.match(html,/\.branch-local-map polyline/);assert.match(html,/\.branch-local-map text/);
 assert.ok(Map.data.buildings.flatMap(b=>b.points.flat()).every(Number.isFinite));
 assert.deepEqual(Map.viewBox([0,0],100),Map.viewBox([0,0],5));assert.deepEqual(Map.viewBox([0,0],0),Map.viewBox([0,0],.7));
 const index=read('index.html');assert.ok(index.indexOf('/branch-webgl-map-data.js')<index.indexOf('/branch-webgl-map.js'));assert.ok(index.indexOf('/branch-webgl-map.js')<index.indexOf('/branch-webgl.js'));
});

test('the map remains usable without WebGL and releases map and viewer listeners on destroy',()=>{
 const listeners=new Map();
 const events=()=>({addEventListener(type,fn){const list=listeners.get(this)||new Map();list.set(type,fn);listeners.set(this,list);},removeEventListener(type){const list=listeners.get(this);list?.delete(type);if(!list?.size)listeners.delete(this);}});
 const status={textContent:''},fallback={hidden:true},canvas={...events(),getContext:()=>null},svg={...events(),setAttribute(name,value){this[name]=value;}};
 const mapNode={hidden:true,innerHTML:'',querySelector:()=>svg,replaceChildren(){this.innerHTML='';}};
 const buttons=['map','in','out','walk'].map(action=>({dataset:{webglAction:action},setAttribute(){}}));
 const win={...events(),requestAnimationFrame:()=>1,cancelAnimationFrame(){}};
 const doc={...events(),defaultView:win,hidden:false};
 const nodes={'canvas':canvas,'[data-webgl-status]':status,'[data-webgl-fallback]':fallback,'[data-webgl-map]':mapNode};
 const root={...events(),dataset:{},ownerDocument:doc,querySelector:s=>nodes[s]||null,querySelectorAll:selector=>selector==='[data-webgl-action]'?buttons:buttons.filter(b=>['map','walk'].includes(b.dataset.webglAction))};
 const viewer=Webgl.mount(root);viewer.activate();assert.equal(buttons[0].disabled,false);assert.equal(buttons[3].disabled,true);
 const click=action=>listeners.get(root).get('click')({target:{closest:()=>({dataset:{webglAction:action}})}});
 click('map');assert.equal(mapNode.hidden,false);assert.equal(canvas.hidden,true);assert.equal(fallback.hidden,true);assert.match(status.textContent,/Lageplan/);
 click('in');const zoomed=svg.viewBox;click('map');assert.notEqual(svg.viewBox,zoomed);
 viewer.suspend();viewer.activate();assert.equal(mapNode.hidden,false);assert.equal(fallback.hidden,true);
 viewer.destroy();assert.equal(listeners.size,0);assert.equal(mapNode.innerHTML,'');
});
