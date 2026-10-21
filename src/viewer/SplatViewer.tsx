import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AppContext, useApp, useSplat } from '@playcanvas/react/hooks';
import { Application as PcApplication, BoundingBox, Color, Entity as PcEntity, Vec3, RESOLUTION_AUTO, FILLMODE_NONE, type GSplatResourceBase } from 'playcanvas';
import { RotateCcw, Play, Pause, Maximize, ZoomIn, ZoomOut } from 'lucide-react';

export interface ViewConfig { rotation: [number, number, number]; yaw: number; pitch: number; distance: number; target?: [number, number, number]; focus?: {center:[number,number,number];halfExtents:[number,number,number]} }
export interface ViewModel { id: string; name: string; url: string; view: ViewConfig }
export type ViewCommand = { type: 'reset' | 'zoom' | 'pose'; value?: number; yaw?: number; pitch?: number; targetY?: number };
type Status = { phase: 'loading' | 'ready' | 'error'; progress: number; message?: string };
type Control = { auto: boolean; command: ViewCommand | null };
declare global { interface Window { __viewer?: Record<string, unknown> } }
const dark = '#101a17';

// Native host avoids the React 0.11.7 picker's ResizeObserver race on unmount.
// The official useSplat hook and engine SOG parser remain the asset-loading path.
function EngineHost({children,onStatus}:{children:ReactNode;onStatus:(s:Status)=>void}){
  const canvas=useRef<HTMLCanvasElement>(null);const [app,setApp]=useState<PcApplication|null>(null);
  useEffect(()=>{
    let instance:PcApplication;
    try{instance=new PcApplication(canvas.current!,{graphicsDeviceOptions:{alpha:false,antialias:false,preserveDrawingBuffer:true},devtools:false});instance.setCanvasFillMode(FILLMODE_NONE);instance.setCanvasResolution(RESOLUTION_AUTO);instance.start();setApp(instance);}
    catch(e){onStatus({phase:'error',progress:0,message:`无法启动 WebGL2。请检查浏览器硬件加速设置。${e instanceof Error?e.message:''}`});return;}
    return()=>{const gl=canvas.current?.getContext('webgl2');const lose=gl?.getExtension('WEBGL_lose_context');
      // Let descendant cleanup remove observers, entities and assets before tearing down the device.
      queueMicrotask(()=>{instance.destroy();lose?.loseContext();window.__viewer={disposed:true,splatAssets:0,appDestroyed:true};});};
  },[onStatus]);
  return <><canvas ref={canvas} aria-label="交互式三维艺术品"/>{app&&<AppContext.Provider value={app}>{children}</AppContext.Provider>}</>;
}

function Scene({ model, control, onStatus }: { model: ViewModel; control: React.RefObject<Control>; onStatus: (s: Status) => void }) {
  const app = useApp();
  const { asset, error, subscribe } = useSplat(model.url);
  useEffect(() => subscribe(meta => onStatus({ phase: 'loading', progress: Math.min(.98, meta.progress ?? 0) })), [subscribe, onStatus]);
  useEffect(() => { if (error) onStatus({ phase: 'error', progress: 0, message: error }); }, [error, onStatus]);
  // useSplat caches assets. Explicitly release the selected asset even if a switch occurs during loading.
  useEffect(() => () => {
    if (!app.assets) { window.__viewer = { disposed:model.id, splatAssets:0, appDestroyed:true }; return; }
    const owned = app.assets.list().filter(a => a.type === 'gsplat' && (a.file as {url?:string})?.url === model.url);
    for (const a of owned) { app.assets.remove(a); a.unload(); }
    window.__viewer = { ...window.__viewer, disposed: model.id, splatAssets: app.assets.list().filter(a => a.type === 'gsplat').length };
  }, [app, model.id, model.url]);
  useEffect(() => {
    const canvas = app.graphicsDevice.canvas as HTMLCanvasElement;
    app.graphicsDevice.maxPixelRatio = Math.min(window.devicePixelRatio, 1.5);
    const resize = () => { if(!app.graphicsDevice||!canvas.isConnected||!canvas.parentElement)return; const r = canvas.parentElement.getBoundingClientRect(); app.resizeCanvas(Math.max(1,r.width), Math.max(1,r.height)); app.renderNextFrame = true; };
    const observer = new ResizeObserver(resize); observer.observe(canvas.parentElement!); resize();
    const lost = (e: Event) => { e.preventDefault(); onStatus({ phase: 'error', progress: 0, message: '图形上下文已中断，请重新加载作品。' }); };
    canvas.addEventListener('webglcontextlost', lost);
    return () => { observer.disconnect(); canvas.removeEventListener('webglcontextlost', lost); };
  }, [app, onStatus]);
  useEffect(() => {
    if (!asset?.resource) return;
    const cam = new PcEntity('Exhibition camera'), obj = new PcEntity(model.name);
    cam.addComponent('camera',{ fov:35, clearColor:new Color().fromString(dark) });
    obj.setLocalEulerAngles(...model.view.rotation);
    obj.addComponent('gsplat',{ asset, unified:true });
    app.root.addChild(cam); app.root.addChild(obj);
    const resource = asset.resource as GSplatResourceBase;
    const localBounds = model.view.focus ? new BoundingBox(new Vec3(...model.view.focus.center),new Vec3(...model.view.focus.halfExtents)) : resource.aabb;
    const bounds = new BoundingBox(); bounds.setFromTransformedAabb(localBounds, obj.getWorldTransform());
    const distribution = import.meta.env.DEV && resource.centers ? [0,1,2].map(axis=>{const values:number[]=[];for(let i=axis;i<resource.centers.length;i+=300)values.push(resource.centers[i]);values.sort((a,b)=>a-b);return [.01,.05,.1,.25,.5,.75,.9,.95,.99].map(p=>values[Math.floor(p*(values.length-1))]);}) : undefined;
    const center = bounds.center.clone();
    const radius = Math.max(bounds.halfExtents.length(), .01);
    const baseDistance = radius / Math.sin(35 * Math.PI / 360) * model.view.distance;
    const baseTarget = center.clone().add(new Vec3(...(model.view.target ?? [0,0,0])).mulScalar(radius));
    let yaw = model.view.yaw, pitch = model.view.pitch, distance = baseDistance;
    let goalYaw = yaw, goalPitch = pitch, goalDistance = distance;
    let target = baseTarget.clone(), goalTarget = target.clone();
    const canvas = app.graphicsDevice.canvas as HTMLCanvasElement;
    const points = new Map<number, { x: number; y: number }>(); let pinch = 0; let frames = 0; let wakeUntil = performance.now()+1500; let lastRender = 0;
    cam.camera!.nearClip = radius * .005; cam.camera!.farClip = radius * 100;
    const zoom = (factor: number) => { goalDistance = Math.max(radius * .35, Math.min(baseDistance * 3, goalDistance * factor)); };
    const down = (e: PointerEvent) => { if(e.pointerType==='mouse' && e.button!==0) return; canvas.setPointerCapture(e.pointerId); points.set(e.pointerId,{ x:e.clientX,y:e.clientY }); };
    const move = (e: PointerEvent) => {
      const prev=points.get(e.pointerId); if(!prev) return;
      if(points.size===1) { goalYaw -= (e.clientX-prev.x)*.32; goalPitch=Math.max(-80,Math.min(80,goalPitch+(e.clientY-prev.y)*.28)); }
      points.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(points.size===2) { const [a,b]=[...points.values()]; const d=Math.hypot(a.x-b.x,a.y-b.y); if(pinch) zoom(pinch/d); pinch=d; }
    };
    const up = (e: PointerEvent) => { points.delete(e.pointerId); pinch=0; };
    const wheel = (e: WheelEvent) => { e.preventDefault(); zoom(Math.exp(Math.max(-300,Math.min(300,e.deltaY))*.0015)); };
    const key = (e: KeyboardEvent) => { if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','-','0'].includes(e.key)) return; e.preventDefault(); if(e.key==='ArrowLeft')goalYaw-=10; if(e.key==='ArrowRight')goalYaw+=10; if(e.key==='ArrowUp')goalPitch=Math.max(-80,goalPitch-10); if(e.key==='ArrowDown')goalPitch=Math.min(80,goalPitch+10); if(e.key==='+')zoom(.8); if(e.key==='-')zoom(1.25); if(e.key==='0')control.current.command={type:'reset'}; };
    canvas.tabIndex=0; canvas.setAttribute('aria-label',`${model.name}三维模型。拖动旋转，滚轮或双指缩放；方向键旋转，0复位。`);
    canvas.addEventListener('pointerdown',down); canvas.addEventListener('pointermove',move); canvas.addEventListener('pointerup',up); canvas.addEventListener('pointercancel',up); canvas.addEventListener('wheel',wheel,{passive:false}); canvas.addEventListener('keydown',key);
    const update = (dt: number) => {
      if(!app.graphicsDevice||!app.root||!app.assets)return;
      if(document.hidden) {app.renderNextFrame=false;return;}
      const cmd=control.current.command;
      if(cmd) { if(cmd.type==='reset') { goalYaw=model.view.yaw; goalPitch=model.view.pitch; goalDistance=baseDistance; goalTarget.copy(baseTarget); } else if(cmd.type==='zoom') zoom(cmd.value ?? 1); else { goalYaw=cmd.yaw ?? model.view.yaw; goalPitch=cmd.pitch ?? model.view.pitch; goalDistance=baseDistance*(cmd.value ?? 1); goalTarget.copy(baseTarget).add(new Vec3(0,(cmd.targetY ?? 0)*radius,0)); } control.current.command=null; }
      if(control.current.auto && points.size===0) goalYaw+=Math.min(dt,.05)*7;
      const smoothing=1-Math.exp(-Math.min(dt,.05)*9);
      yaw+=(goalYaw-yaw)*smoothing; pitch+=(goalPitch-pitch)*smoothing; distance+=(goalDistance-distance)*smoothing; target.lerp(target,goalTarget,smoothing);
      const y=yaw*Math.PI/180,p=pitch*Math.PI/180;
      // On narrow screens increase distance to preserve the horizontal field of view.
      const aspect=canvas.width/canvas.height; const fit=Math.max(1,1/aspect);
      cam.setPosition(target.x+distance*fit*Math.cos(p)*Math.sin(y),target.y+distance*fit*Math.sin(p),target.z+distance*fit*Math.cos(p)*Math.cos(y)); cam.lookAt(target);
      const moving=Math.abs(goalYaw-yaw)+Math.abs(goalPitch-pitch)+Math.abs(goalDistance-distance)+target.distance(goalTarget)>.001;
      const now=performance.now(); if(moving||control.current.auto)wakeUntil=now+700;
      // Keep a short settling window for asynchronous Gaussian sorting, then stop drawing.
      if(now<wakeUntil&&now-lastRender>=1000/60){app.renderNextFrame=true;lastRender=now;}
      window.__viewer={id:model.id,ready:true,yaw,pitch,distance,baseDistance,radius,center:center.toArray(),distribution,position:cam.getPosition().toArray(),splats:resource.numSplats,frames:++frames,splatAssets:app.assets.list().filter(a=>a.type==='gsplat').length,textureBytes:(app.graphicsDevice as unknown as {_vram:{tex:number}})._vram?.tex};
    };
    app.autoRender=false; app.on('update',update); update(1/60);
    onStatus({phase:'ready',progress:1});
    return () => { app.off('update',update); canvas.removeEventListener('pointerdown',down); canvas.removeEventListener('pointermove',move); canvas.removeEventListener('pointerup',up); canvas.removeEventListener('pointercancel',up); canvas.removeEventListener('wheel',wheel); canvas.removeEventListener('keydown',key); obj.destroy(); cam.destroy(); app.autoRender=true; };
  }, [app, asset, model, control, onStatus]);
  return null;
}

export function SplatViewer({ model, minimal=false, command, auto=false }: {model:ViewModel;minimal?:boolean;command?:ViewCommand;auto?:boolean}) {
  const [status,setStatus]=useState<Status>({phase:'loading',progress:0});
  const [rotating,setRotating]=useState(auto); const [retry,setRetry]=useState(0); const [fullscreenError,setFullscreenError]=useState('');
  const host=useRef<HTMLDivElement>(null); const control=useRef<Control>({auto,command:null});
  useEffect(()=>{control.current.auto=rotating;},[rotating]);
  useEffect(()=>{if(command){control.current.command=command;setRotating(false);}},[command]);
  useEffect(()=>{setStatus({phase:'loading',progress:0});},[model.id,retry]);
  useEffect(()=>{const timeout=setTimeout(()=>setStatus(s=>s.phase==='loading'?{phase:'error',progress:0,message:'加载等待时间较长。请检查本地模型文件与服务器，再重新加载。'}:s),60000);return()=>clearTimeout(timeout);},[model.id,retry]);
  const fullscreen=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await host.current?.requestFullscreen();}catch{setFullscreenError('当前浏览器不支持全屏，请使用浏览器的全屏功能。');}};
  return <div ref={host} className={`splat-viewer ${minimal?'minimal':''}`} data-phase={status.phase} data-model={model.id}>
    <EngineHost onStatus={setStatus}><Scene key={`${model.id}-${retry}`} model={model} control={control} onStatus={setStatus}/></EngineHost>
    {status.phase!=='ready' && <div className="viewer-status" role="status"><span className="loading-seal">云</span><strong>{status.phase==='error'?'作品暂未抵达':'正在唤醒一件珍藏'}</strong>{status.phase==='error'?<><p>{status.message}</p><button onClick={()=>setRetry(n=>n+1)}>重新加载</button></>:<><div className="progress-track"><i style={{width:`${Math.round(status.progress*100)}%`}}/></div><span>{status.progress>.97?'正在解码与准备画面':`加载作品 ${Math.round(status.progress*100)}%`}</span></>}</div>}
    {!minimal && <><div className="viewer-hint">拖动旋转 · 滚轮缩放 · 双指捏合</div><div className="viewer-tools"><button aria-label="放大" onClick={()=>control.current.command={type:'zoom',value:.8}}><ZoomIn size={18}/></button><button aria-label="缩小" onClick={()=>control.current.command={type:'zoom',value:1.25}}><ZoomOut size={18}/></button><span/><button aria-label="视角复位" onClick={()=>{control.current.command={type:'reset'};setRotating(false);}}><RotateCcw size={18}/></button><button aria-label={rotating?'关闭自动旋转':'开启自动旋转'} aria-pressed={rotating} onClick={()=>setRotating(!rotating)}>{rotating?<Pause size={18}/>:<Play size={18}/>}</button><span/><button aria-label="全屏查看" onClick={fullscreen}><Maximize size={18}/></button></div>{fullscreenError&&<p className="fullscreen-error" role="status">{fullscreenError}</p>}</>}
  </div>;
}




