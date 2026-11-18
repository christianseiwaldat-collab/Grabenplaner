(function(root,factory){'use strict';const api=factory(typeof module==='object'&&module.exports?require('./branch-webgl-map-data'):root.GrabenplanerBranchMapData);if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GrabenplanerBranchMap=api;
}(typeof globalThis==='object'?globalThis:this,function(Data){
  'use strict';
  const BASE=Object.freeze([-118,-164,270,275]);
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const points=p=>p.map(v=>v.join(',')).join(' ');
  const width=type=>({primary:16,secondary:12,tertiary:10,residential:7,service:4.5,unclassified:6,footway:1.7,path:1.5,cycleway:2,steps:1.5}[type]||5);
  const names={Lamprechter:'Lamprechter · Fil18',Orion:'ORION',JYSK:'JYSK',Hervis:'Hervis','Onkel Hasan':'Onkel Hasan','Greif Center':'Greif Center'};
  const positions={Lamprechter:[-75,9,67,25],Orion:[-9,23,31,18],JYSK:[11,46,33,18],Hervis:[72,17,48,22],'Onkel Hasan':[91,-57,59,22],'Greif Center':[-20,-93,71,24]};
  const colors={Lamprechter:'#bd293d',Orion:'#9460a6',JYSK:'#416ca1',Hervis:'#337982','Onkel Hasan':'#cb7936','Greif Center':'#8068a1'};
  function roadLabel(name,preferred){
    const choices=[];for(const road of Data.roads.filter(r=>r.name===name))for(let i=1;i<road.points.length;i++){
      const a=road.points[i-1],b=road.points[i],length=Math.hypot(b[0]-a[0],b[1]-a[1]);if(length<5)continue;
      const center=[(a[0]+b[0])/2,(a[1]+b[1])/2];choices.push({center,angle:Math.atan2(b[1]-a[1],b[0]-a[0])*180/Math.PI,distance:Math.hypot(center[0]-preferred[0],center[1]-preferred[1])});
    }
    const c=choices.sort((a,b)=>a.distance-b.distance)[0];if(!c)return '';let angle=c.angle;if(angle>90)angle-=180;if(angle< -90)angle+=180;
    return '<text class="bm-road-label" transform="translate('+c.center.join(' ')+') rotate('+angle+')" text-anchor="middle">'+esc(name)+'</text>';
  }
  function markup(){
    const parking=Data.areas.filter(a=>a.kind==='parking').map(a=>'<polygon points="'+points(a.points)+'" fill="#e5e6e4"/>').join('');
    const greens=Data.areas.filter(a=>['grass','park','forest','meadow'].includes(a.kind)).map(a=>'<polygon points="'+points(a.points)+'" fill="#dbe8d5"/>').join('');
    const buildings=Data.buildings.map(b=>'<polygon points="'+points(b.points)+'" class="bm-building'+(b.id==='47110371'?' bm-own-building':'')+'"/>').join('');
    const roads=Data.roads.filter(r=>!['construction','proposed','platform','corridor'].includes(r.type)).sort((a,b)=>width(a.type)-width(b.type));
    const roadMarkup=roads.map(r=>'<polyline points="'+points(r.points)+'" fill="none" stroke="#d0d4d1" stroke-width="'+(width(r.type)+.65)+'"/>').join('')+roads.map(r=>'<polyline points="'+points(r.points)+'" fill="none" stroke="'+(['primary','secondary'].includes(r.type)?'#fff4d0':['footway','path','cycleway'].includes(r.type)?'#e5dfd3':'#fff')+'" stroke-width="'+width(r.type)+'"/>').join('');
    const labels=Data.places.map(place=>{
      const [x,y,w,h]=positions[place.name],p=place.point,color=colors[place.name],left=x-w/2,top=y-h/2;
      return '<g aria-label="'+esc(names[place.name]+', '+place.address)+'"><path d="M '+p.join(' ')+' L '+x+' '+y+'" stroke="'+color+'" stroke-width=".55" fill="none"/><circle cx="'+p[0]+'" cy="'+p[1]+'" r="'+(place.name==='Lamprechter'?2.7:1.9)+'" fill="'+color+'" stroke="#fff" stroke-width=".8"/><rect x="'+left+'" y="'+top+'" width="'+w+'" height="'+h+'" rx="3" fill="#fff" stroke="'+(place.name==='Lamprechter'?color:'#d3d9d4')+'" stroke-width="'+(place.name==='Lamprechter'? 0.8:.35)+'"/><circle cx="'+(left+6)+'" cy="'+(top+7)+'" r="2" fill="'+color+'"/><text x="'+(left+11)+'" y="'+(top+8.5)+'" class="bm-place" fill="'+color+'">'+esc(names[place.name])+'</text><text x="'+(left+5)+'" y="'+(top+15.2)+'" class="bm-address">'+esc(place.address)+'</text>'+(place.name==='Lamprechter'?'<text x="'+(left+5)+'" y="'+(top+21)+'" class="bm-address" fill="#567b65">Fotowelt · FineArt-Druck</text>':'')+'</g>';
    }).join('');
    return '<svg class="branch-local-map" xmlns="http://www.w3.org/2000/svg" viewBox="'+BASE.join(' ')+'" width="1100" height="1120" role="img" tabindex="0" aria-label="Lageplan Filiale Grabenweg mit Grabenweg, Andechsstraße, Amraser-See-Straße, Greif Center, Hervis, Onkel Hasan, JYSK und ORION"><title>Lageplan Grabenweg · Filiale 18</title><style>.bm-building{fill:#dcdedb;stroke:#bfc7c1;stroke-width:.45}.bm-own-building{fill:#e3ece5;stroke:#6d9480;stroke-width:1.15}.bm-place{font:600 5px Arial,sans-serif}.bm-address{font:3.7px Arial,sans-serif;fill:#68756e}.bm-road-label{font:4.5px Arial,sans-serif;fill:#69746d;paint-order:stroke;stroke:#fff;stroke-width:1.4;stroke-linejoin:round}.bm-caption{font:3.2px Arial,sans-serif;fill:#5c7063}.branch-local-map polyline{stroke-linecap:round;stroke-linejoin:round}.branch-local-map text{pointer-events:none}</style><rect x="-2000" y="-2000" width="4000" height="4000" fill="#f3f4f0"/><g aria-hidden="true">'+greens+parking+buildings+roadMarkup+'</g>'+roadLabel('Grabenweg',[35,-22])+roadLabel('Andechsstraße',[-56,-45])+roadLabel('Amraser-See-Straße',[30,84])+roadLabel('Dr.-Ferdinand-Kogler-Straße',[-88,41])+labels+'<g aria-hidden="true"><path d="M 137 -148 L 134 -138 L 137 -140 L 140 -138 Z" fill="#637b6c"/><text x="137" y="-152" text-anchor="middle" class="bm-place" fill="#637b6c">N</text><path d="M -108 99 v3 h50 v-3" fill="none" stroke="#637b6c" stroke-width=".6"/><text x="-83" y="96" text-anchor="middle" class="bm-address">50 m</text></g><a href="https://www.openstreetmap.org/copyright" target="_blank"><text x="-108" y="108" class="bm-caption">© OpenStreetMap-Mitwirkende · ODbL</text></a></svg>';
  }
  function viewBox(center,zoom){const z=Math.max(.7,Math.min(5,zoom));return [center[0]-BASE[2]/z/2,center[1]-BASE[3]/z/2,BASE[2]/z,BASE[3]/z];}
  function mount(root){
    root.innerHTML=markup()+'<p class="branch-map-credit">Straßen und Gebäude: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap-Mitwirkende · ODbL</a>. Geschäftspunkte sind Orientierungspunkte; Innenabgrenzungen und Eingänge sind noch nicht vermessen.</p>';
    const svg=root.querySelector('svg');let zoom=1,center=[BASE[0]+BASE[2]/2,BASE[1]+BASE[3]/2],drag=null;const off=[];
    const draw=()=>svg.setAttribute('viewBox',viewBox(center,zoom).join(' '));
    const on=(type,fn,options)=>{svg.addEventListener(type,fn,options);off.push(()=>svg.removeEventListener(type,fn,options));};
    const resize=factor=>{zoom=Math.max(.7,Math.min(5,zoom*factor));draw();};
    on('wheel',event=>{event.preventDefault();resize(Math.exp(-Math.max(-100,Math.min(100,event.deltaY))*.002));},{passive:false});
    on('pointerdown',event=>{if(event.button!==0)return;drag={id:event.pointerId,x:event.clientX,y:event.clientY};svg.setPointerCapture(event.pointerId);svg.focus({preventScroll:true});});
    on('pointermove',event=>{if(!drag||drag.id!==event.pointerId)return;const bounds=svg.getBoundingClientRect(),box=viewBox(center,zoom),scale=Math.min(bounds.width/box[2],bounds.height/box[3]);center[0]-=(event.clientX-drag.x)/scale;center[1]-=(event.clientY-drag.y)/scale;drag.x=event.clientX;drag.y=event.clientY;draw();});
    const cancel=()=>{if(drag&&svg.hasPointerCapture?.(drag.id))svg.releasePointerCapture(drag.id);drag=null;};on('pointerup',cancel);on('pointercancel',cancel);on('lostpointercapture',()=>{drag=null;});
    on('keydown',event=>{if(event.ctrlKey||event.metaKey||event.altKey)return;const shift=12/zoom;if(event.key==='ArrowLeft')center[0]-=shift;else if(event.key==='ArrowRight')center[0]+=shift;else if(event.key==='ArrowUp')center[1]-=shift;else if(event.key==='ArrowDown')center[1]+=shift;else if(event.key==='+')resize(1.2);else if(event.key==='-')resize(1/1.2);else return;event.preventDefault();draw();});
    return {zoom:resize,reset(){zoom=1;center=[BASE[0]+BASE[2]/2,BASE[1]+BASE[3]/2];draw();},suspend:cancel,destroy(){cancel();for(const stop of off)stop();root.replaceChildren();}};
  }
  return Object.freeze({markup,mount,viewBox,base:BASE,data:Data});
}));
