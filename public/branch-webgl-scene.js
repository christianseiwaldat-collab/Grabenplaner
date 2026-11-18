(function(root,factory){'use strict';const common=typeof module==='object'&&module.exports;
  const api=factory(common?require('./branch-webgl-plotter'):root.GrabenplanerBranchPlotter,
    common?require('./branch-webgl-materials'):root.GrabenplanerBranchMaterials);
  if(common)module.exports=api;else root.GrabenplanerBranchScene=api;
}(globalThis,function(Plotter,Materials){
  'use strict';
  const referenceUrl='https://lamprechter.com/Service/UEber-uns-Karriere/Unsere-Standorte-Teams/Filiale-Grabenweg/';
  // Traced from the user's GREEN outline, then rotated parallel to the street.
  // Scale and heights are provisional; this is not a surveyed building model.
  const referenceOutline=[[1016,469],[1246,397],[1280,403],[1294,421],[1333,547],[1066,629],[1046,580],[943,608],[936,590],[948,561],[967,539],[976,520],[993,509],[1024,504],[1027,496]];
  const buildingFootprint=referenceOutline.map(([x,y])=>{const dx=x-1016,dy=y-469;return [(dx*.954-dy*.300)*.085,(dx*.300+dy*.954)*.085];});
  // Relative proportions from the owner's yellow boundary / red Orion mullion.
  // These model coordinates are provisional, not measured tenancy dimensions.
  const tenancy=Object.freeze({shopEnd:8,orionGlassStart:8.7,dimensionsVerified:false,source:'owner-annotated-exterior-20261118'});
  function clipDepth(polygon,depth,before=true){
    const out=[],inside=p=>before?p[1]<=depth:p[1]>=depth;
    for(let i=0;i<polygon.length;i++){const a=polygon[i],b=polygon[(i+1)%polygon.length],ai=inside(a),bi=inside(b);if(ai)out.push(a.slice());if(ai!==bi){const t=(depth-a[1])/(b[1]-a[1]);out.push([a[0]+t*(b[0]-a[0]),depth]);}}
    return out;
  }
  const footprint=clipDepth(buildingFootprint,tenancy.shopEnd),neighborFootprint=clipDepth(buildingFootprint,tenancy.shopEnd,false);
  // The owner's viewing arrow places the entrance on the parking-side façade.
  // Its exact position on that façade still needs the measured floor plan.
  const entranceEdge=[buildingFootprint[3],buildingFootprint[4]],entranceDelta=entranceEdge[1].map((v,i)=>v-entranceEdge[0][i]),entranceLength=Math.hypot(...entranceDelta);
  const entrance=Object.freeze({center:entranceEdge[0].map((v,i)=>v+entranceDelta[i]*.20),tangent:entranceDelta.map(v=>v/entranceLength),normal:[entranceDelta[1]/entranceLength,-entranceDelta[0]/entranceLength],width:2.8,type:'sliding',state:'open',positionVerified:false,widthVerified:false});
  const entrancePoint=u=>entrance.center.map((v,i)=>v+entrance.tangent[i]*u);
  const assumptions=Object.freeze({status:'proportions_only',scaleVerified:false,interiorLayoutVerified:false,heightVerified:false,heightAcceptedApproximately:true,provisionalHeight:3.3,referenceUrl,location:'Grabenweg 2, Innsbruck',branch:'18',tenancySource:tenancy.source});
  const palette={wall:[.78,.79,.77],red:[.72,.06,.10],black:[.08,.09,.10],frame:[.46,.49,.50],glass:[.52,.76,.82,.22],light:[1,.98,.88]};
  const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  function contains(x,z,polygon=footprint){let inside=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const a=polygon[i],b=polygon[j];if((a[1]>z)!==(b[1]>z)&&x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }return inside;}
  function triangulate(polygon){
    const area=polygon.reduce((n,a,i)=>{const b=polygon[(i+1)%polygon.length];return n+a[0]*b[1]-b[0]*a[1];},0);
    const ids=polygon.map((_,i)=>i);if(area<0)ids.reverse();const triangles=[];
    while(ids.length>3){let found=false;for(let i=0;i<ids.length;i++){
      const a=ids[(i+ids.length-1)%ids.length],b=ids[i],c=ids[(i+1)%ids.length];if(cross(polygon[a],polygon[b],polygon[c])<=1e-8)continue;
      const enclosed=ids.some(k=>![a,b,c].includes(k)&&cross(polygon[a],polygon[b],polygon[k])>=-1e-8&&cross(polygon[b],polygon[c],polygon[k])>=-1e-8&&cross(polygon[c],polygon[a],polygon[k])>=-1e-8);
      if(enclosed)continue;triangles.push([a,b,c]);ids.splice(i,1);found=true;break;
    }if(!found)throw Error('Invalid branch footprint');}triangles.push(ids);return triangles;
  }
  function distanceToSegment(x,z,a,b){const dx=b[0]-a[0],dz=b[1]-a[1],length=dx*dx+dz*dz,t=length?Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/length)):0;return Math.hypot(x-a[0]-t*dx,z-a[1]-t*dz);}
  function create(){
    const opaque=[],glass=[],ceiling=[],lines=[],shadows=[],labels=[],obstacles=[],exteriorObstacles=[],walls=[],equipment=[];
    const surfaceVertices=new Map();
    const vertex=(bucket,p,color)=>bucket.push(...p,color[0],color[1],color[2],color[3]??1);
    const tri=(bucket,a,b,c,color)=>{for(const p of[a,b,c])vertex(bucket,p,color);};
    const quad=(bucket,a,b,c,d,color)=>{tri(bucket,a,b,c,color);tri(bucket,a,c,d,color);};
    const shade=(color,k)=>color.map((v,i)=>i<3?v*k:v);
    function box(x,y,z,w,h,d,color,bucket=opaque){
      quad(bucket,[x,y,z],[x+w,y,z],[x+w,y+h,z],[x,y+h,z],shade(color,.88));
      quad(bucket,[x+w,y,z+d],[x,y,z+d],[x,y+h,z+d],[x+w,y+h,z+d],color);
      quad(bucket,[x,y,z+d],[x,y,z],[x,y+h,z],[x,y+h,z+d],shade(color,.76));
      quad(bucket,[x+w,y,z],[x+w,y,z+d],[x+w,y+h,z+d],[x+w,y+h,z],shade(color,.90));
      quad(bucket,[x,y+h,z],[x+w,y+h,z],[x+w,y+h,z+d],[x,y+h,z+d],shade(color,1.06));
    }
    function floor(polygon,y,color,bucket=opaque){for(const[a,b,c]of triangulate(polygon))tri(bucket,[polygon[a][0],y,polygon[a][1]],[polygon[b][0],y,polygon[b][1]],[polygon[c][0],y,polygon[c][1]],color);}
    function textureVertices(material) {
      if (!surfaceVertices.has(material)) surfaceVertices.set(material, []);
      return surfaceVertices.get(material);
    }
    function ground(polygon, y, material) {
      const vertices = textureVertices(material), scale = Materials.surfaces[material].tileMetres;
      for (const triangle of triangulate(polygon)) {
        for (const index of triangle) {
          const [x, z] = polygon[index];
          vertices.push(x, y, z, x / scale, z / scale);
        }
      }
    }
    function texturedQuad(material, points, uv) {
      const vertices = textureVertices(material);
      for (const index of [0, 1, 2, 0, 2, 3]) vertices.push(...points[index], ...uv[index]);
    }
    function shadow(x, z, w, d, y, opacity) {
      const falloff = .21;
      const inner = [[x, y, z], [x + w, y, z], [x + w, y, z + d], [x, y, z + d]];
      const outer = [[x - falloff, y, z - falloff], [x + w + falloff, y, z - falloff],
        [x + w + falloff, y, z + d + falloff], [x - falloff, y, z + d + falloff]];
      const tint = [.08, .09, .08, opacity], transparent = [...tint.slice(0, 3), 0];
      quad(shadows, ...inner, tint);
      for (let i = 0; i < 4; i += 1) {
        const next = (i + 1) % 4;
        vertex(shadows, inner[i], tint);
        vertex(shadows, outer[i], transparent);
        vertex(shadows, outer[next], transparent);
        vertex(shadows, inner[i], tint);
        vertex(shadows, outer[next], transparent);
        vertex(shadows, inner[next], tint);
      }
    }
    function wall(a,b,color,height=assumptions.provisionalHeight,base=0,collide=true,bucket=opaque){
      quad(bucket,[a[0],base,a[1]],[b[0],base,b[1]],[b[0],height,b[1]],[a[0],height,a[1]],color);
      if(collide)walls.push([a,b]);
    }
    function cladWall(a,b,height=assumptions.provisionalHeight,base=0,collide=true) {
      const scale=Materials.surfaces.facade.tileMetres;
      const span=Math.hypot(b[0]-a[0],b[1]-a[1])/scale;
      texturedQuad('facade',[[a[0],base,a[1]],[b[0],base,b[1]],[b[0],height,b[1]],[a[0],height,a[1]]],
        [[0,base/scale],[span,base/scale],[span,height/scale],[0,height/scale]]);
      if(collide)walls.push([a,b]);
    }
    function windowBay(a,b,height,color=palette.glass) {
      wall(a,b,color,height,0,true,glass);
      const length=Math.hypot(b[0]-a[0],b[1]-a[1]);
      const divisions=Math.max(1,Math.ceil(length/1.36));
      for(let i=0;i<=divisions;i+=1) {
        const ratio=i/divisions;
        const x=a[0]+(b[0]-a[0])*ratio,z=a[1]+(b[1]-a[1])*ratio;
        box(x-.037,0,z-.037,.074,height,.074,[.45,.47,.47]);
      }
      for(const y of [.1,height-.11]) wall(a,b,[.41,.43,.43],y+.048,y,false);
    }
    const line=(a,b,color)=>{vertex(lines,a,color);vertex(lines,b,color);};
    const label=(text,a,b,c,d,theme='dark',vertical=false)=>labels.push({text,points:[a,b,c,d],theme,vertical});
    // A simplified context volume for the remainder of the shared building.
    const context=[[-.4,9.7],[-9.4,9.4],[-7,22],[-3,48],[-1,59],[2,65],[20,65],[24,62],[23.7,14.3],[-.1,14.2]];
    const rectangle = (x1, z1, x2, z2) => [[x1,z1],[x2,z1],[x2,z2],[x1,z2]];
    const roadY = -.145, parkingY = -.115, walkY = -.024;
    const roadAxis = [[-63,-12.1],[-33,-10.5],[-11,-9.7],[44,-9.7],[64,-10.1],[93,-11.5]];
    const roadside = offset => roadAxis.map(([x, z]) => [x, z + offset]);
    ground(rectangle(-100,-78,120,125), -.225, 'grass');
    ground([...roadside(-4.45), ...roadside(4.45).reverse()], roadY, 'road');

    // Low-detail ridges suggest the valley setting from the supplied street photos.
    function ridge(z,mean,seed,color) {
      const height=x=>mean+5*Math.sin((x+seed)/24)+3.2*Math.cos((x-seed)/12)+1.6*Math.sin((x+seed)/5.7);
      const groundColor=shade(color,.77);
      const peak=(x,y)=>vertex(opaque,[x,y,z],shade(color,.91+.09*Math.sin((x+seed)/17)));
      for(let x=-438;x<198;x+=6) {
        const next=x+6,y=height(x),endY=height(next);
        vertex(opaque,[x,-.23,z],groundColor);
        vertex(opaque,[next,-.23,z],groundColor);
        peak(next,endY);
        vertex(opaque,[x,-.23,z],groundColor);
        peak(next,endY);
        peak(x,y);
      }
    }
    ridge(190,31,38,[.47,.56,.65]);
    ridge(151,21,-38,[.40,.51,.54]);
    ridge(126,12,12,[.36,.47,.43]);

    // A paved forecourt links the Grabenweg driveway with the parking-side entrance.
    const forecourt = [[-15,-3.6],[18.8,-3.6],[24.9,-2.9],[27.2,-3.7],[28,-5.45],[36.8,-5.5],
      [38.6,-3.2],[42.4,10],[41.5,59],[36.9,67.2],[22.8,71],[-9.8,66],[-14.4,24]];
    ground(forecourt, parkingY, 'parking');
    const walkEdge = [[-11.3,7.2],[-8,2.4],[-4.4,-1.65],[19.9,-1.65],[22,-1.22],
      [24.35,.24],[25.65,2.75],[25.65,4.0],[25.65,6.95],[25.57,15.25],[24.2,16.0],[-10.8,15.5]];
    ground(walkEdge, walkY, 'pavers');
    for (let i = 0; i < walkEdge.length; i += 1) {
      const a = walkEdge[i], b = walkEdge[(i + 1) % walkEdge.length];
      const doorApproach = i === 7;
      const lip = doorApproach ? parkingY + .018 : walkY;
      quad(opaque, [a[0],parkingY,a[1]], [b[0],parkingY,b[1]], [b[0],lip,b[1]], [a[0],lip,a[1]], [.46,.449,.418]);
      const [dx, dz] = [b[0]-a[0], b[1]-a[1]], length = Math.hypot(dx,dz);
      for (let start = 0; start < length; start += .92) {
        const end = Math.min(length,start+.906);
        const near = t => [a[0]+dx*t/length, a[1]+dz*t/length];
        const far = p => [p[0]-dz*.132/length,p[1]+dx*.132/length];
        const p = near(start), q = near(end);
        if (doorApproach) {
          const [r,s] = [far(q),far(p)];
          quad(opaque,[p[0],lip,p[1]],[q[0],lip,q[1]],[r[0],walkY+.002,r[1]],[s[0],walkY+.002,s[1]],[.65,.64,.60]);
        } else {
          ground([p,q,far(q),far(p)], walkY + .003, 'concrete');
        }
      }
    }

    // Pavement, gutter and painted lines follow the street geometry.
    for (const [x1,x2] of [[-43,27.7],[37.1,59]]) {
      ground(rectangle(x1,-4.95,x2,-3.86), -.122, 'grass');
      ground(rectangle(x1,-5.20,x2,-4.95), -.076, 'concrete');
      box(x1,roadY,-5.20,x2-x1,.069,.038,[.43,.426,.39]);
    }
    for (let x=-48; x<58; x+=5.7) ground(rectangle(x,-9.76,x+2.9,-9.64), roadY+.004, 'paint');
    ground(rectangle(-11,-5.68,26.1,-5.56),roadY+.004,'paint');
    ground(rectangle(37.45,-5.68,54,-5.56),roadY+.004,'paint');
    for (let z=9.6; z<=57; z+=2.55) ground(rectangle(25.76,z,30.82,z+.102),parkingY+.003,'paint');
    ground(rectangle(30.72,9.6,30.82,57.92),parkingY+.003,'paint');
    for (let x=25.9; x<29.75; x+=.62) ground(rectangle(x,4.17,x+.26,6.67),parkingY+.004,'paint');

    // Flush drainage and an offset tarmac repair around the driveway.
    ground([[31.8,-3.1],[36.45,-3.36],[37.3,1.3],[32.5,2.07]],parkingY+.002,'road');
    for (const [x,z] of [[8.4,-1.97],[21.85,-1.62],[26.04,7.4],[33.1,-5.07]]) {
      box(x,parkingY,z,.44,.016,.27,[.17,.18,.179]);
      for (let i=0;i<7;i+=1) box(x+.041+i*.053,parkingY+.017,z+.025,.011,.003,.22,[.34,.348,.339]);
    }
    function parkedCar(x,z,paint,length=4.2) {
      const y=parkingY;
      const half=length/2;
      const outline=[[-half+.18,-.86],[half-.17,-.86],[half,-.67],[half,.67],
        [half-.17,.86],[-half+.18,.86],[-half,.67],[-half,-.67]];
      const body=outline.map(([px,pz])=>[x+px,z+pz]);
      floor(body,y+.83,shade(paint,1.24));
      for(let i=0;i<body.length;i+=1) wall(body[i],body[(i+1)%body.length],shade(paint,i<4? 0.92:.76),y+.83,y+.28,false);
      const belt=[[-1.28,-.82],[1.27,-.82],[1.27,.82],[-1.28,.82]];
      const upper=[[-.69,-.66],[.65,-.66],[.65,.66],[-.69,.66]];
      const at=(p,h)=>[x+p[0],y+h,z+p[1]];
      for(let i=0;i<4;i+=1) {
        const next=(i+1)%4,glassTint=i%2?[.20,.28,.31]:[.15,.23,.26];
        quad(opaque,at(belt[i],.83),at(belt[next],.83),at(upper[next],1.42),at(upper[i],1.42),glassTint);
      }
      quad(opaque,...upper.map(p=>at(p,1.42)),shade(paint,1.19));
      for(const px of [-half+.84,half-.81]) {
        for(const side of [-1,1]) {
          const wz=z+side*.87,center=[x+px,y+.29,wz],edge=(i,r)=>[center[0]+Math.cos(i*Math.PI/8)*r,center[1]+Math.sin(i*Math.PI/8)*r,wz];
          for(let i=0;i<16;i+=1) {
            tri(opaque,center,edge(i,.29),edge(i+1,.29),[.062,.067,.068]);
            const rim=[center[0],center[1],wz+side*.012];
            const turn=p=>[p[0],p[1],rim[2]];
            tri(opaque,rim,turn(edge(i,.157)),turn(edge(i+1,.157)),i%2?[.46,.48,.49]:[.32,.34,.35]);
          }
        }
      }
      for(const offset of [-.7,.39]) {
        box(x-half-.009,y+.63,z+offset,.018,.125,.30,[.82,.855,.845]);
        box(x+half-.009,y+.62,z+offset,.018,.14,.30,[.53,.072,.075]);
      }
      shadow(x-half,z-.91,length,1.82,y+.006,.32);
      exteriorObstacles.push({kind:'car',minX:x-half,maxX:x+half,minZ:z-.91,maxZ:z+.91});
    }
    parkedCar(28.34,10.88,[.13,.21,.28]);
    parkedCar(28.31,15.98,[.55,.57,.57],4.35);
    parkedCar(28.37,21.08,[.35,.11,.12],4.05);
    parkedCar(28.24,28.73,[.21,.27,.24],4.45);

    function tree(x,z,scale,color) {
      const y=-.22;
      box(x-.1*scale,y,z-.1*scale,.2*scale,2.7*scale,.2*scale,[.37,.29,.22]);
      for(const [ox,oy,oz,radius] of [[0,3.28,0,1.56],[-.61,2.89,.25,1.07],[.66,3.05,-.33,1.19],[.1,4.13,-.18,.92]]) {
        const shell=(ring,sector)=>{
          const elevation=(ring-2)*Math.PI/4,azimuth=sector*Math.PI/5;
          const extent=radius*scale*(1+.09*Math.sin(sector*2.4+ring*1.7));
          return [x+ox*scale+Math.cos(azimuth)*Math.cos(elevation)*extent,
            y+oy*scale+Math.sin(elevation)*extent,z+oz*scale+Math.sin(azimuth)*Math.cos(elevation)*extent];
        };
        for(let ring=0;ring<4;ring+=1)for(let sector=0;sector<10;sector+=1) {
          const next=(sector+1)%10;
          const light=.77+.12*ring+.11*Math.cos(sector*.73);
          quad(opaque,shell(ring,sector),shell(ring,next),shell(ring+1,next),shell(ring+1,sector),shade(color,light));
        }
      }
    }
    tree(-16.6,26,1.24,[.35,.41,.25]);
    tree(-23.2,29,1.38,[.51,.45,.25]);
    tree(-31.2,35,1.10,[.32,.39,.26]);
    tree(44.1,18,1.24,[.43,.44,.26]);
    tree(46.5,32,1.41,[.34,.39,.24]);
    tree(-20.47,1.8,.92,[.44,.43,.24]);
    ground(rectangle(33.3,13.94,35.05,16.18),-.057,'grass');
    tree(34.22,15.10,1.15,[.49,.47,.25]);
    exteriorObstacles.push({kind:'tree',minX:34.02,maxX:34.42,minZ:14.90,maxZ:15.30});

    shadow(.8,-.98,20.8,.66,walkY+.01,.24);
    shadow(22.64,1.65,1.98,12.17,walkY+.012,.21);
    floor(context,4.15,[.64,.67,.65]);
    for(let i=0;i<context.length;i++)cladWall(context[i],context[(i+1)%context.length],4.15);
    ground(footprint,0,'ceramic');floor(footprint,3.3,[.86,.86,.83],ceiling);
    floor(neighborFootprint,0,[.70,.72,.73]);floor(neighborFootprint,3.3,[.82,.83,.82],ceiling);
    for(let i=0;i<footprint.length;i++){
      const a=footprint[i],b=footprint[(i+1)%footprint.length];
      if(a[1]===tenancy.shopEnd&&b[1]===tenancy.shopEnd)wall(a,b,palette.wall);
      else if(i===3){const start=entrancePoint(-entrance.width/2),end=entrancePoint(entrance.width/2);windowBay(a,start,2.65);windowBay(end,b,2.65);cladWall(a,b,3.3,2.65,false);}
      else if(i>=7){windowBay(a,b,3.05,[.52,.72,.77,.23]);cladWall(a,b,3.3,3.05,false);}
      else cladWall(a,b);
      line([a[0],.025,a[1]],[b[0],.025,b[1]],[.12,.46,.31]);
    }
    // Adjacent Orion glazing begins beyond the solid separation pier.
    const facadeAt=z=>[entranceEdge[0][0]+entranceDelta[0]*(z-entranceEdge[0][1])/entranceDelta[1],z];
    const neighborStart=facadeAt(tenancy.shopEnd),glassStart=facadeAt(tenancy.orionGlassStart),neighborEnd=buildingFootprint[4];
    cladWall(neighborStart,glassStart);windowBay(glassStart,neighborEnd,2.8,[.40,.55,.60,.36]);cladWall(glassStart,neighborEnd,3.3,2.8,false);
    for(let i=0;i<neighborFootprint.length;i++){const a=neighborFootprint[i],b=neighborFootprint[(i+1)%neighborFootprint.length];if(a[1]===tenancy.shopEnd&&b[1]===tenancy.shopEnd)continue;if(Math.abs(a[0]-facadeAt(a[1])[0])<.01&&Math.abs(b[0]-facadeAt(b[1])[0])<.01)continue;wall(a,b,[.67,.69,.69]);}
    box(neighborStart[0]-.12,0,tenancy.shopEnd,.26,3.3,tenancy.orionGlassStart-tenancy.shopEnd,palette.wall);
    box(neighborStart[0]+.15,0,tenancy.shopEnd-.015,.025,3.3,.03,[.98,.73,.12]);
    const orionX=facadeAt(11)[0]+.11;
    label('ORION',[orionX,2.86,13.2],[orionX,2.86,9.1],[orionX,3.24,9.1],[orionX,3.24,13.2]);
    // Widened sliding entrance, shown open so the walk-through is unobstructed.
    const [ex,ez]=entrance.center;
    const half=entrance.width/2;
    for(const offset of[-half-.1,half])box(ex-.08,0,ez+offset,.16,2.72,.1,palette.red);
    box(ex-.08,2.64,ez-half-.1,.16,.11,entrance.width+.2,palette.red);box(ex-.06,2.76,ez-half-.16,.18,.08,entrance.width+.32,palette.frame);
    box(ex-.1,2.85,ez-half-.35,1.3,.08,entrance.width+.7,[.50,.64,.64,.48],glass);
    for(const offset of[-entrance.width,half]){box(ex-.10,.08,ez+offset,.035,2.52,half,[.52,.76,.82,.28],glass);for(const edge of[0,half-.035])box(ex-.12,.06,ez+offset+edge,.07,2.56,.035,palette.frame);}
    label('LAMPRECHTER  |  FOTOWELT',[ex+.10,2.86,ez+2.3],[ex+.10,2.86,ez-2.3],[ex+.10,3.28,ez-2.3],[ex+.10,3.28,ez+2.3],'brand');
    label('EINGANG',[ex+.14,2.32,ez+half-.1],[ex+.14,2.32,ez-half+.1],[ex+.14,2.59,ez-half+.1],[ex+.14,2.59,ez+half-.1],'red');
    box(18,.016,ez-half+.12,ex-18,.008,entrance.width-.24,[.48,.04,.08]);
    label('FOTOWELT  |  LAMPRECHTER',[.8,3.35,-.03],[5.4,3.35,-.03],[5.4,4.1,-.03],[.8,4.1,-.03],'brand');
    // Alternating façade fins and the corner signs visible in the branch photos.
    for(let i=0;i<3;i++){const x=15.2+i*1.9;box(x,.65,-.18,1.22,3.5,.22,i%2? [.94,.94,.92]:palette.red);
      label(i%2?'FOTOWELT':'LAMPRECHTER',[x,.72,-.195],[x+1.22,.72,-.195],[x+1.22,4.05,-.195],[x,4.05,-.195],i%2?'white':'red',true);
    }
    // Faceted corner and vertical fascia strips visible in the supplied street views.
    box(.6,.5,-.08,12.5,2.25,.08,palette.frame);
    label('FOTOWELT  |  FINEART-DRUCK',[.75,.68,-.09],[12.95,.68,-.09],[12.95,2.56,-.09],[.75,2.56,-.09],'brand');
    for(const index of[1,2]){const a=buildingFootprint[index],b=buildingFootprint[index+1],dx=b[0]-a[0],dz=b[1]-a[1],length=Math.hypot(dx,dz),normal=[dz/length,-dx/length],count=Math.max(1,Math.floor(length/1.25));
      for(let n=0;n<count;n++){const point=t=>[a[0]+dx*t+normal[0]*.05,a[1]+dz*t+normal[1]*.05],p=point((n+.04)/count),q=point((n+.96)/count),red=(n+index)%2===0;
        const r=p.map((v,i)=>v+normal[i]*.008),s=q.map((v,i)=>v+normal[i]*.008);
        wall(p,q,red?palette.red:[.94,.94,.92],4.1,.65,false);label(red?'LAMPRECHTER':'FOTOWELT',[r[0],.72,r[1]],[s[0],.72,s[1]],[s[0],4.03,s[1]],[r[0],4.03,r[1]],red?'red':'white',true);
      }
    }
    ground(rectangle(4.25,1.7,12.65,7.7), .024, 'wood');
    // Photo-derived furnishing types; the exact layout remains unverified.
    function fixture(id,x,z,w,d,height=1.1){
      if(![[x,z],[x+w,z],[x,z+d],[x+w,z+d]].every(p=>contains(...p)))return;
      obstacles.push({id,minX:x,maxX:x+w,minZ:z,maxZ:z+d});
      box(x,0,z,w,.18,d,palette.frame);box(x,.18,z,w,.72,d,[.30,.34,.36]);
      for(let y=.93;y<height;y+=.38)box(x,y,z,w,.035,d,[.72,.75,.75]);
      box(x,.9,z,w,height-.9,d,palette.glass,glass);
      for(const sx of[x,x+w-.035])box(sx,.88,z,.035,height-.88,d,[.49,.52,.53]);
      for(let i=0;i<Math.max(1,Math.floor(w/.5));i++){
        const px=x+.13+i*.5;box(px,1.02,z+.14,.21,.15,.16,palette.black);box(px+.045,1.055,z+.045,.12,.09,.10,[.035,.04,.045]);
      }
      box(x,.04,z-.008,w,.025,.02,[.28,.32,.88]);
    }
    const plotterMesh = { box, tri: (a,b,c,color)=>tri(opaque,a,b,c,color),
      quad: (a,b,c,d,color)=>quad(opaque,a,b,c,d,color), label, texturedQuad };
    for (const [id, x, artwork] of [['canon-pro-2000-1',5.6,'fine-art-colour'],['canon-pro-2000-2',8.0,'fine-art-mono']]) {
      const z = 3.5, { width, depth } = Plotter.dimensions;
      shadow(x + .018, z + .02, width - .036, depth - .04, .026, .32);
      Plotter.add(plotterMesh,x,z,artwork);
      equipment.push({id,model:'Canon imagePROGRAF PRO-2000',position:[x,0,z],dimensions:Plotter.dimensions,
        basketPosition:1,placementVerified:false,source:Plotter.source});
      obstacles.push({id,minX:x,maxX:x+width,minZ:z,maxZ:z+depth});
    }
    box(4.6,1.78,.002,5.9,.42,.04,palette.frame);
    label('FOTOWELT  ·  FINEART-DRUCK',[4.65,1.82,.044],[10.45,1.82,.044],[10.45,2.16,.044],[4.65,2.16,.044],'red');
    box(4.28,0,.022,8.33,.11,.028,[.49,.47,.43]);
    for(const [x,artwork] of [[5.30,'fine-art-colour'],[8.25,'fine-art-mono']]) {
      const center=[x+.59,1.27,.023],lit=[1,.96,.84,.29],unlit=[1,.96,.84,0];
      const edge=i=>[center[0]+1.54*Math.cos(i*Math.PI/16),center[1]+.48*Math.sin(i*Math.PI/16),center[2]];
      for(let i=0;i<32;i+=1) {
        vertex(shadows,center,lit);
        vertex(shadows,edge(i),unlit);
        vertex(shadows,edge(i+1),unlit);
      }
      box(x,1.03,.028,1.18,.62,.035,[.15,.167,.17]);
      box(x+.025,1.055,.064,1.13,.57,.003,[.92,.9,.84]);
      texturedQuad(artwork,[[x+.12,1.12,.069],[x+1.06,1.12,.069],
        [x+1.06,1.558,.069],[x+.12,1.558,.069]],[[0,1],[1,1],[1,0],[0,0]]);
    }
    fixture('mittelvitrine-1',14.4,2.3,3,.65,1.75);fixture('mittelvitrine-2',14.4,6.7,3,.65,1.75);
    fixture('beratungstheke',5,6.4,7.4,1.1,1.25);
    label('FOTOWELT  ·  FINEART',[4.6,2.2,7.94],[12.8,2.2,7.94],[12.8,2.9,7.94],[4.6,2.9,7.94]);
    label('LAMPRECHTER  ·  PERFEKT IM BILD',[13,2.25,7.94],[22.4,2.25,7.94],[22.4,3,7.94],[13,3,7.94],'red');
    fixture('wandvitrine',22.1,6.8,.65,.9,2.25);
    for(let x=5;x<21;x+=3.2){
      box(x,.05,7.45,2.7,2.05,.48,[.68,.69,.66]);
      for(let y=.45;y<2;y+=.42){box(x,y,7.05,2.7,.04,.9,palette.red);for(let n=0;n<5;n++)box(x+.12+n*.5,y+.04,7.16,.35,.28,.32,n%3?[.17,.19,.22]:[.54,.50,.38]);}
      obstacles.push({id:'wandregal-'+x,minX:x,maxX:x+2.7,minZ:7.05,maxZ:8});
    }
    for(const x of[1,7,14,20])for(const z of[2,5.2])box(x,3.08,z,.14,.09,2.3,palette.light,ceiling);
    for(let x=-5;x<1;x+=2.2)if(contains(x,5.5))fixture('fotorahmen-'+x,x,5.5,.7,1.7,1.8);
    const surfaces = Array.from(surfaceVertices, ([material, vertices]) => ({ material, vertices: new Float32Array(vertices) }));
    return {opaque:new Float32Array(opaque),glass:new Float32Array(glass),ceiling:new Float32Array(ceiling),
      lines:new Float32Array(lines),shadows:new Float32Array(shadows),surfaces,labels,obstacles,exteriorObstacles,walls,footprint,
      buildingFootprint,neighborFootprint,tenancy,assumptions,equipment,entrance};
  }
  const entranceView=distance=>({x:entrance.center[0]+entrance.normal[0]*distance,z:entrance.center[1]+entrance.normal[1]*distance,yaw:Math.atan2(entrance.normal[0],entrance.normal[1]),pitch:0});
  const spawn=()=>entranceView(-1.65);
  const streetView=()=>({x:28,z:-12,yaw:Math.atan2(8,-13),pitch:-.08,fieldOfView:60});
  const fotoweltView=()=>({camera:{yaw:.09,pitch:.315,distance:2.89,fieldOfView:51},target:[7.35,.64,3.50]});
  function blocked(scene,x,z,radius=.25){
    if(!Number.isFinite(x)||!Number.isFinite(z)||x< -20||x>35||z< -15||z>72)return true;
    if(scene.walls.some(([a,b])=>distanceToSegment(x,z,a,b)<radius))return true;
    const overlaps=o=>x>o.minX-radius&&x<o.maxX+radius&&z>o.minZ-radius&&z<o.maxZ+radius;
    return scene.obstacles.some(overlaps)||scene.exteriorObstacles.some(overlaps);
  }
  function move(scene,player,right,forward,seconds,running=false){
    const distance=Math.min(.1,Math.max(0,seconds))*(running?3.6:1.7),length=Math.max(1,Math.hypot(right,forward));
    const dx=(Math.cos(player.yaw)*right-Math.sin(player.yaw)*forward)/length*distance;
    const dz=(-Math.sin(player.yaw)*right-Math.cos(player.yaw)*forward)/length*distance;
    const steps=Math.max(1,Math.ceil(Math.hypot(dx,dz)/.1)),next={...player};
    for(let i=0;i<steps;i++){if(!blocked(scene,next.x+dx/steps,next.z))next.x+=dx/steps;if(!blocked(scene,next.x,next.z+dz/steps))next.z+=dz/steps;}
    return next;
  }
  return Object.freeze({create,spawn,entranceView,streetView,fotoweltView,entrance,move,blocked,contains,triangulate,footprint,buildingFootprint,neighborFootprint,tenancy,assumptions});
}));
