import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import ts from "typescript";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import * as wireframe from "../lib/wireframe.ts";

const require=createRequire(import.meta.url);
const transpile=async path=>ts.transpileModule(await readFile(new URL(path,import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const compiled=await transpile("../lib/model-client.ts");
function client(api){
  const exports={};
  new Function("require","exports","setTimeout","clearTimeout",compiled)(name=>{
    if(name==="./desktop")return {desktop:api};
    if(name==="./wireframe")return wireframe;
    throw Error(`Unexpected import: ${name}`);
  },exports,(fn,ms)=>setTimeout(fn,ms===1500?0:ms),clearTimeout);
  return exports.modelImage;
}
const image={src:"data:image/png;base64,aW1hZ2U=",name:"fixture.png",width:703,height:1193};
const result={title:"Fixture",summary:"Draft",width:703,height:1193,nodes:[wireframe.makeNode("progress",{value:0.78,text:"78%"})]};
const telemetry={stage:"recognizing",activityAgeMs:46000,eventCount:2,outputChars:0,nodeCount:null,timeoutMs:300000,warning:null};
const done={status:"done",message:"Result file ready",elapsed:47000,result,error:null,progress:{...telemetry,stage:"complete",nodeCount:1,outputChars:JSON.stringify(result).length}};
let passed=0;
async function test(name,run){await run();passed++;console.log(`PASS ${name}`);}

await test("real event progress reaches the UI and completion follows strict validation",async()=>{
  let polls=0;
  const seen=[];
  const model=client({visionStart:async()=>({id:"progress-fixture"}),visionGet:async()=>++polls===1?{status:"running",message:"Waiting for model",elapsed:46000,progress:telemetry}:done,visionCancel:async()=>{}});
  const project=await model(image,703,new AbortController().signal,event=>seen.push(event));
  assert.equal(project.nodes[0].value,0.78);
  assert.ok(seen.some(event=>event.activityAgeMs===46000&&event.remainingMs===254000));
  assert.equal(seen.at(-1).state,"complete");
  assert.equal(seen.at(-1).nodeCount,1);
  assert.ok(seen.some(event=>event.stage==="validating"));
  assert.equal(seen.filter(event=>event.stage==="complete").length,1);
  assert.ok(seen.every(event=>!Object.hasOwn(event,"percent")));
});
await test("invalid recognized values never report completion",async()=>{
  const seen=[];
  const model=client({visionStart:async()=>({id:"bad-value"}),visionGet:async()=>({...done,result:{...result,nodes:[{...result.nodes[0],value:78}]}})});
  await assert.rejects(model(image,703,new AbortController().signal,event=>seen.push(event)),/value=78/);
  assert.equal(seen.at(-1).state,"failed");
  assert.ok(seen.every(event=>event.stage!=="complete"));
});
await test("pre-aborted requests never launch Codex",async()=>{
  const controller=new AbortController();controller.abort();
  const seen=[];
  await assert.rejects(client({visionStart:()=>{throw Error("Must not start");}})(image,703,controller.signal,event=>seen.push(event)),/已取消/);
  assert.equal(seen.at(-1).state,"cancelled");
});
await test("cancellation after a poll starts cannot apply a late successful result",async()=>{
  const controller=new AbortController(),seen=[];
  let cancelled=0;
  const model=client({visionStart:async()=>({id:"cancel-fixture"}),visionCancel:async()=>{cancelled++;},visionGet:async()=>{controller.abort();return done;}});
  await assert.rejects(model(image,703,controller.signal,event=>seen.push(event)),/已取消/);
  assert.equal(cancelled,1);
  assert.equal(seen.at(-1).state,"cancelled");
  assert.ok(seen.every(event=>event.state!=="complete"));
});
await test("a failed cancellation remains explicit rather than claiming success",async()=>{
  const controller=new AbortController(),seen=[];
  const model=client({visionStart:async()=>({id:"cancel-error"}),visionCancel:async()=>{throw Error("Fixture IPC failure");},visionGet:async()=>{controller.abort();return done;}});
  await assert.rejects(model(image,703,controller.signal,event=>seen.push(event)));
  assert.equal(seen.at(-1).state,"failed");
  assert.match(seen.at(-1).warning,/未获确认/);
});
await test("older development services disclose missing telemetry without fake percentages",async()=>{
  const seen=[];
  await client({visionStart:async()=>({id:"legacy"}),visionGet:async()=>({...done,progress:undefined})})(image,703,new AbortController().signal,event=>seen.push(event));
  assert.ok(seen.some(event=>event.warning?.includes("未提供事件进度")));
  assert.ok(seen.every(event=>event.remainingMs===null));
});
await test("progress markup describes milestones and real inactivity, not a completion percentage",async()=>{
  const exports={};
  new Function("require","exports",await transpile("../components/recognition-progress.tsx"))(require,exports);
  const progress={...telemetry,state:"running",message:"等待模型识别",elapsedMs:105000,observedAt:Date.now(),serviceSeenAt:Date.now(),remainingMs:195000};
  const html=renderToStaticMarkup(React.createElement(exports.RecognitionProgress,{progress,onCancel:()=>{}}));
  for(const text of ["准备图片","模型识别","校验组件","完成","01:45","46 秒前","03:15","本机服务有响应","模型尚未返回新事件","取消解析"])assert.ok(html.includes(text),text);
  assert.ok(!/aria-valuenow|role="progressbar"|\d+%/.test(html));
  const completed=renderToStaticMarkup(React.createElement(exports.RecognitionProgress,{progress:{...progress,stage:"complete",state:"complete",message:"已完成",nodeCount:1},onCancel:()=>{}}));
  assert.ok(!completed.includes("取消解析"));
  assert.equal((completed.match(/data-state="done"/g)||[]).length,4);
});
console.log(`Model progress checks passed: ${passed}`);
