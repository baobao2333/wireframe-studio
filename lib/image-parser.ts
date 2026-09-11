import type { Worker as OCRWorker } from "tesseract.js";
import { blankProject, makeNode, type Project, type WNode } from "./wireframe";
type CV = typeof import("@techstark/opencv-js");
let cvPromise: Promise<CV> | null = null;
function loadCV(): Promise<CV> {
  if (cvPromise) return cvPromise;
  cvPromise = new Promise<CV>((resolve,reject) => {
    const script=document.createElement("script");script.src="/ocr/opencv.js";
    script.onerror=()=>reject(new Error("图形解析引擎加载失败，请检查网络后重试"));
    script.onload=async()=>{try{const cv=await (window as unknown as {cv:CV|Promise<CV>}).cv;if(!cv?.Mat)throw Error("OpenCV 未完成初始化");resolve(cv);}catch(e){reject(e);}};
    document.head.appendChild(script);
  }).catch(e=>{cvPromise=null;throw e;});
  return cvPromise;
}
export async function readImage(file: File): Promise<{src:string;width:number;height:number;name:string}> {
  if(!["image/png","image/jpeg","image/webp"].includes(file.type))throw Error("请选择 PNG、JPG 或 WebP 图片");
  if(file.size>20*1024*1024)throw Error("图片不能超过 20 MB");
  const url=URL.createObjectURL(file),img=new Image();
  try { img.src=url;await img.decode();if(img.naturalWidth*img.naturalHeight>40000000)throw Error("图片像素过大，请先裁剪到单个界面");
    const scale=Math.min(1,1600/img.naturalWidth,2400/img.naturalHeight);const canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));const ctx=canvas.getContext("2d");if(!ctx)throw Error("浏览器不支持图片处理");ctx.fillStyle="#ffffff";ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);return {src:canvas.toDataURL("image/png"),width:canvas.width,height:canvas.height,name:file.name};
  }finally{URL.revokeObjectURL(url);}
}
type Box={x:number;y:number;w:number;h:number};
const contains=(a:Box,b:Box,pad=0)=>b.x>=a.x-pad&&b.y>=a.y-pad&&b.x+b.w<=a.x+a.w+pad&&b.y+b.h<=a.y+a.h+pad;
function detectShapes(cv:CV,canvas:HTMLCanvasElement): Box[] {
  const src=cv.imread(canvas),gray=new cv.Mat(),edges=new cv.Mat(),contours=new cv.MatVector(),hierarchy=new cv.Mat();
  try { cv.cvtColor(src,gray,cv.COLOR_RGBA2GRAY);
    const boxes:Box[]=[];
    for(const mode of ["edge","filled"]){
      if(mode==="edge")cv.Canny(gray,edges,30,100,3,false);else cv.threshold(gray,edges,235,255,cv.THRESH_BINARY_INV);
      cv.findContours(edges,contours,hierarchy,cv.RETR_LIST,cv.CHAIN_APPROX_SIMPLE);
      for(let i=0;i<contours.size();i++){const contour=contours.get(i);try{const r=cv.boundingRect(contour);const area=r.width*r.height,coverage=Math.abs(cv.contourArea(contour))/area;const line=r.width>canvas.width*.12&&r.height<=4;const rect=area>400&&coverage>.72&&r.width>28&&r.height>14;
      if((line||rect)&&area<canvas.width*canvas.height*.92)boxes.push({x:r.x,y:r.y,w:r.width,h:r.height});
      }finally{contour.delete();}}
    }
    const unique:Box[]=[];boxes.sort((a,b)=>b.w*b.h-a.w*a.h).forEach(b=>{if(!unique.some(a=>Math.abs(a.x-b.x)<=5&&Math.abs(a.y-b.y)<=5&&Math.abs(a.w-b.w)<=10&&Math.abs(a.h-b.h)<=10))unique.push(b);});
    return unique.slice(0,250);
  }finally{src.delete();gray.delete();edges.delete();contours.delete();hierarchy.delete();}
}
export async function parseImage(image:{src:string;width:number;height:number;name:string}, options:{width:number;language:"eng"|"chi_sim+eng";signal:AbortSignal;onProgress:(p:number,label:string)=>void}):Promise<Project> {
  const { createWorker, PSM } = await import("tesseract.js");
  const {signal,onProgress}=options;let worker:OCRWorker|undefined;let timer:ReturnType<typeof setTimeout>|undefined;let fatalReject:(e:Error)=>void=()=>{};let active=true;
  const fatal=new Promise<never>((_,reject)=>{fatalReject=reject;});
  const abort=()=>{void worker?.terminate();fatalReject(new Error("已取消解析"));};signal.addEventListener("abort",abort,{once:true});
  try { if(signal.aborted)throw Error("已取消解析");timer=setTimeout(()=>{void worker?.terminate();fatalReject(new Error("解析超过 3 分钟，请裁剪图片后重试"));},180000);
    onProgress(2,"加载本地图形解析引擎");const cv=await Promise.race([loadCV(),fatal]);
    const img=new Image();img.src=image.src;await img.decode();const canvas=document.createElement("canvas");canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext("2d");if(!ctx)throw Error("无法创建解析画布");ctx.drawImage(img,0,0);
    onProgress(12,"识别容器和图形边界");const boxes=detectShapes(cv,canvas);await new Promise(r=>requestAnimationFrame(r));
    const init=createWorker(options.language,1,{workerPath:"/ocr/worker.min.js",corePath:"/ocr/core",langPath:"/ocr/lang",workerBlobURL:false,logger:m=>onProgress(m.status==="recognizing text"?35+m.progress*55:18+m.progress*15,m.status==="recognizing text"?"识别文字和位置":"加载本地文字识别模型"),errorHandler:e=>fatalReject(new Error(`OCR 失败：${String(e)}`))});
    void init.then(w=>{if(signal.aborted||!active)void w.terminate();},()=>{});worker=await Promise.race([init,fatal]);
    await worker.setParameters({tessedit_pageseg_mode:PSM.SPARSE_TEXT,preserve_interword_spaces:"1"});
    const {data}=await Promise.race([worker.recognize(canvas,{}, {blocks:true}),fatal]);
    if(!data.blocks&&!boxes.length)throw Error("未识别到文字或图形边界，请换一张清晰的界面截图");
    const scale=options.width/image.width;
    const lines=(data.blocks||[]).flatMap(b=>b.paragraphs.flatMap(p=>p.lines)).filter(l=>l.text.trim().length>0&&l.confidence>=35);
    // Dark controls need a light-background crop; a page-wide pass can miss reversed text.
    const dark=boxes.filter(b=>b.h>18&&b.h<140&&b.w>50&&b.w<600).filter(b=>{
      if(lines.some(l=>contains(b,{x:l.bbox.x0,y:l.bbox.y0,w:l.bbox.x1-l.bbox.x0,h:l.bbox.y1-l.bbox.y0},3)))return false;
      const pixels=ctx.getImageData(b.x,b.y,b.w,b.h).data;let sum=0;for(let i=0;i<pixels.length;i+=16)sum+=(pixels[i]+pixels[i+1]+pixels[i+2])/3;
      return sum/(pixels.length/16)<145;
    }).slice(0,12);
    if(dark.length)await worker.setParameters({tessedit_pageseg_mode:PSM.SINGLE_BLOCK});
    for(let i=0;i<dark.length;i++) {
      if(signal.aborted)throw Error("已取消解析");onProgress(91+i/dark.length*6,"识别深色控件中的文字");const b=dark[i],crop=document.createElement("canvas");crop.width=b.w+24;crop.height=b.h+24;const cc=crop.getContext("2d");if(!cc)throw Error("无法创建控件识别画布");cc.fillStyle="#ffffff";cc.fillRect(0,0,crop.width,crop.height);const pixels=ctx.getImageData(b.x,b.y,b.w,b.h);for(let k=0;k<pixels.data.length;k+=4){const v=255-Math.round((pixels.data[k]+pixels.data[k+1]+pixels.data[k+2])/3);pixels.data[k]=pixels.data[k+1]=pixels.data[k+2]=v;}cc.putImageData(pixels,12,12);
      const extra=await Promise.race([worker.recognize(crop,{}, {blocks:true}),fatal]);
      for(const l of (extra.data.blocks||[]).flatMap(block=>block.paragraphs.flatMap(p=>p.lines)).filter(l=>l.confidence>=45&&l.text.trim()))lines.push({...l,bbox:{x0:l.bbox.x0+b.x-12,y0:l.bbox.y0+b.y-12,x1:l.bbox.x1+b.x-12,y1:l.bbox.y1+b.y-12}});
    }
    const tallest=Math.max(1,...lines.map(l=>l.bbox.y1-l.bbox.y0));
    const textNodes:WNode[]=lines.map(l=>{
      const b=l.bbox,text=l.text.trim().replace(/\s*\n\s*/g," "),fontWeight=b.y1-b.y0>=tallest*.8?"600":"400";
      ctx.font=`${fontWeight} 100px Arial, "Microsoft YaHei", sans-serif`;
      const fontSize=Math.max(8,Math.min(160,Math.floor((b.x1-b.x0)*scale/Math.max(1,ctx.measureText(text).width)*100)));
      ctx.font=`${fontWeight} ${fontSize}px Arial, "Microsoft YaHei", sans-serif`;
      return makeNode("text",{name:text.slice(0,36),text,x:Math.round(b.x0*scale),y:Math.round(b.y0*scale-fontSize*.16),w:Math.max(12,Math.ceil((b.x1-b.x0)*scale+4),Math.ceil(ctx.measureText(text).width)+4),h:Math.max(12,Math.ceil(fontSize*1.4)),fontSize,fontWeight,lineHeight:1.4,priority:b.y1-b.y0>=tallest*.8?"primary":fontSize<=12?"tertiary":"secondary",origin:"detected",reviewed:false,confidence:Math.max(0,Math.min(100,l.confidence)),note:"文字、字号和位置由 OCR 估算，需人工确认。"});
    });
    const shapes:WNode[]=boxes.filter(b=>!textNodes.some(n=>contains({x:n.x/scale,y:n.y/scale,w:n.w/scale,h:n.h/scale},b,3))).map(b=>{
      const inside=textNodes.filter(n=>contains(b,{x:n.x/scale,y:n.y/scale,w:n.w/scale,h:n.h/scale},8));
      const isLine=b.h<=4;const isControl=!isLine&&b.h*scale<72&&b.w*scale<500&&inside.length===1;
      const type=isLine?"line":isControl?"button":inside.length?"frame":"image";
      return makeNode(type,{x:Math.round(b.x*scale),y:Math.round(b.y*scale),w:Math.max(4,Math.round(b.w*scale)),h:Math.max(2,Math.round(b.h*scale)),text:"",name:isLine?"分隔线":isControl?inside[0].name:"识别区域",fill:isControl?"#f3f4f5":type==="image"?"#f3f4f5":"none",stroke:"#bfc3ca",color:"#34363c",origin:"detected",reviewed:false,confidence:null,note:"边界与组件类型由图形规则推测，需人工确认。"});
    });
    // Labels remain editable text children; merge only unambiguous single-label controls.
    const consumed=new Set<string>();
    shapes.filter(n=>n.type==="button").forEach(n=>{const inside=textNodes.filter(t=>contains(n,t,8));if(inside.length===1){const t=inside[0];n.text=t.text;n.fontSize=t.fontSize;n.fontWeight=t.fontWeight;n.confidence=t.confidence;consumed.add(t.id);}});
    const nodes=[...shapes,...textNodes.filter(n=>!consumed.has(n.id))];
    const frames=shapes.filter(n=>n.type==="frame");nodes.forEach(n=>{const parent=frames.filter(f=>f.id!==n.id&&f.w*f.h>n.w*n.h&&contains(f,n,2)).sort((a,b)=>a.w*a.h-b.w*b.h)[0];if(parent)n.parentId=parent.id;});
    if(!nodes.length)throw Error("未识别到可编辑组件。请换一张清晰、完整的界面截图。");
    if(nodes.length>1000)throw Error("识别超过 1000 个组件，请裁剪到单个界面后重试");
    const height=Math.round(image.height*scale);if(height<240||height>6000)throw Error("画布高度须在 240 至 6000 px 之间，请调整目标宽度");
    onProgress(100,"解析完成");return {...blankProject(),name:image.name.replace(/\.[^.]+$/, "")+" · 线框",width:options.width,height,nodes,reference:image,notes:"此项目由图片识别生成。所有 detected 组件须人工确认；未确认的文字、类型、字号、优先级和位置均为推测，不是最终规范。"};
  }finally{active=false;signal.removeEventListener("abort",abort);if(timer)clearTimeout(timer);await worker?.terminate();}
}
