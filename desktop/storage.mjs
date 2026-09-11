import {readFile,mkdir,open,rename,copyFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {randomUUID} from "node:crypto";

const names={"wireframe-studio-v2":"autosave.json","wireframe-library-v2":"library.json","wireframe-studio-v1":"legacy-project.json","wireframe-studio-v2-before-style-repair":"backup-before-style-repair.json","wireframe-studio-v2-before-canvas-repair":"backup-before-canvas-repair.json"};
export async function atomicJson(path,value) {
  const encoded=JSON.stringify(value);
  if(encoded===undefined)throw Error("工程数据无法保存为 JSON");
  if(Buffer.byteLength(encoded)>50*1024*1024)throw Error("工程数据超过 50 MB，请减少图片后重试");
  const tmp=`${path}.${randomUUID()}.tmp`;
  try {
    const file=await open(tmp,"wx",0o600);
    try{await file.writeFile(encoded);await file.sync();}finally{await file.close();}
    await rename(tmp,path);
  }finally{await rm(tmp,{force:true});}
}
export function createStorage(directory) {
  const pending=new Map(),failed=new Map();let timer,flushing=null;
  const pathFor=key=>{if(!Object.hasOwn(names,key))throw Error("不支持的存储项");return join(directory,names[key]);};
  function flush() {
    clearTimeout(timer);
    if(flushing)return flushing;
    flushing=Promise.resolve().then(async()=>{
      let batch=new Map([...failed].map(([key,entry])=>[key,{value:entry.value,waiters:[]}]));
      for(const [key,entry] of pending)batch.set(key,entry);
      pending.clear();
      do {
        for(const [key,entry] of batch){
          try{await mkdir(directory,{recursive:true});await atomicJson(pathFor(key),entry.value);failed.delete(key);entry.waiters.forEach(w=>w.resolve());}
          catch(error){failed.set(key,{value:entry.value,error});entry.waiters.forEach(w=>w.reject(error));}
        }
        // A save acknowledgement may enqueue another edit before close completes.
        await Promise.resolve();
        batch=new Map(pending);pending.clear();clearTimeout(timer);
      }while(batch.size);
      if(failed.size){const errors=[...failed.values()].map(entry=>entry.error);throw new AggregateError(errors,errors.map(e=>e.message).join("; "));}
    }).finally(()=>{flushing=null;});
    return flushing;
  }
  return {
    async get(key){pathFor(key);await flush();try{return JSON.parse(await readFile(pathFor(key),"utf8"));}catch(error){if(error.code==="ENOENT")return undefined;throw Error(`本地数据读取失败：${error.message}`);}},
    set(key,value){pathFor(key);return new Promise((resolve,reject)=>{const prior=pending.get(key);pending.set(key,{value,waiters:[...(prior?.waiters||[]),{resolve,reject}]});clearTimeout(timer);timer=setTimeout(()=>void flush().catch(()=>{}),150);});},
    flush,
    async backup(){await flush();const path=join(directory,`autosave-backup-${Date.now()}-${randomUUID()}.json`);try{await copyFile(pathFor("wireframe-studio-v2"),path);}catch(e){if(e.code==="ENOENT")return null;throw e;}return path;},
  };
}
