import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import * as m from "../lib/wireframe.ts";
import { visionSchema } from "../server/vision-schema.mjs";
const root=resolve(import.meta.dirname,"..");
const p=m.sampleProject();assert.equal(m.validateProject(p).nodes.length,27);
assert.throws(()=>m.validateProject({...p,nodes:[p.nodes[0],p.nodes[0]]}),/重复/);
assert.throws(()=>m.validateProject({...p,nodes:p.nodes.map((n,i)=>i===0?{...n,parentId:n.id}:n)}),/循环/);
assert.throws(()=>m.validateProject({...p,nodes:[{...p.nodes[0],x:Infinity}]}));
assert.throws(()=>m.validateProject({...p,reference:{src:"https://example.com/tracking.png",name:"remote",width:1,height:1}}));
const rich=m.makeNode("richtext");assert.equal(rich.runs.map(r=>r.text).join(""),rich.text);
assert.equal(visionSchema.properties.nodes.items.properties.lineHeight.maximum,3);
assert.equal(visionSchema.properties.nodes.items.properties.confidence.maximum,100);
const modelNodeSchema=visionSchema.properties.nodes.items.properties;
assert.equal(modelNodeSchema.value.minimum,0);
assert.equal(modelNodeSchema.value.maximum,1);
assert.equal(modelNodeSchema.runs.items.properties.fontSize.minimum,8);
assert.equal(modelNodeSchema.runs.items.properties.fontSize.maximum,160);
const recognition={title:"Value regression",summary:"",width:703,height:1193,nodes:Array.from({length:16},(_,i)=>m.makeNode(i===15?"progress":"text",{id:`node-${i}`,name:`component-${i}`,text:i===15?"78%":"$12,450",value:0}))};
for(const value of [0,0.78,1]){
  const input=structuredClone(recognition);input.nodes[15].value=value;
  const before=structuredClone(input),result=m.recognitionProject(input,null,703);
  assert.equal(result.nodes[15].value,value);assert.equal(result.nodes[15].text,"78%");
  assert.equal(result.nodes[0].text,"$12,450");assert.deepEqual(input,before);
  assert.ok(result.nodes.every(n=>n.origin==="detected"&&!n.reviewed));
}
for(const type of ["progress","text"]){
  for(const value of [-0.1,1.01,78]){
    const input=structuredClone(recognition);input.nodes[15].type=type;input.nodes[15].value=value;
    assert.throws(()=>m.validateProject({...m.blankProject(),nodes:input.nodes}),e=>e.issues[0].path.join(".")==="nodes.15.value");
    assert.throws(()=>m.recognitionProject(input,null,703),e=>e.message.includes("第 16 个组件")&&e.message.includes("component-15")&&e.message.includes(`value=${value}`)&&e.message.includes("0～1"));
    assert.equal(input.nodes[15].value,value);
  }
}
const invalidRun={...recognition,nodes:[m.makeNode("richtext")]};invalidRun.nodes[0].runs[0].fontSize=161;
assert.throws(()=>m.recognitionProject(invalidRun,null,703),/runs\.0\.fontSize=161/);
const symbols=["🎁","❤️","👩🏽‍💻","ⓘ","<img src=x onerror=alert(1)> & \"text\""];
const symbolRecognition={...recognition,nodes:symbols.map((text,index)=>m.makeNode("icon",{id:`symbol-${index}`,text,icon:"heart",note:"语义占位，待确认",confidence:75,value:0}))};
const symbolBefore=structuredClone(symbolRecognition);
const symbolProject=m.recognitionProject(symbolRecognition,null,703);
assert.deepEqual(symbolProject.nodes.map(node=>node.text),symbols);
assert.ok(symbolProject.nodes.every(node=>node.type==="icon"&&node.icon==="heart"&&node.origin==="detected"&&!node.reviewed&&node.note==="语义占位，待确认"&&node.confidence===75));
assert.deepEqual(m.validateProject(JSON.parse(JSON.stringify(symbolProject))).nodes.map(node=>node.text),symbols);
assert.deepEqual(symbolRecognition,symbolBefore);
assert.equal(m.makeNode("icon").text,"");
assert.equal(m.makeNode("icon").icon,"search");
assert.match(modelNodeSchema.text.description,/type=icon/);
assert.match(modelNodeSchema.icon.description,/text empty/);
const fixture=`<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="760"><rect width="1120" height="760" fill="white"/><rect x="0" y="0" width="1120" height="72" fill="#f0f3f6"/><g font-family="Arial,Microsoft YaHei,sans-serif"><text x="40" y="47" font-size="24" font-weight="700" fill="#292d34">WORKSPACE</text><text x="40" y="156" font-size="40" font-weight="700" fill="#25272b">项目概览</text><text x="40" y="195" font-size="22" fill="#646b75">Manage all projects in one place</text><rect x="864" y="120" width="208" height="56" rx="5" fill="#166c55"/><text x="890" y="155" font-size="24" fill="#ffffff">New project</text><rect x="40" y="250" width="1032" height="390" rx="5" fill="white" stroke="#9299a1" stroke-width="2"/><text x="66" y="291" font-size="24" fill="#222a31">Recent projects</text><path d="M40 312H1072" stroke="#9299a1" stroke-width="2"/>${["Website redesign","Mobile workspace","Design system"].map((name,i)=>`<rect x="66" y="${342+i*88}" width="68" height="54" fill="#dae3e9" stroke="#a6b2bc"/><text x="158" y="${366+i*88}" font-size="24" fill="#242b34">${name}</text><text x="158" y="${393+i*88}" font-size="18" fill="#747d88">Updated September ${9-i}</text><rect x="884" y="${350+i*88}" width="146" height="36" rx="4" fill="#edf3ef" stroke="#9faaa3"/><text x="908" y="${375+i*88}" font-size="20" fill="#3c574a">In progress</text>`).join("")}</g></svg>`;
await mkdir(resolve(root,"work"),{recursive:true});
await sharp(Buffer.from(fixture)).png().toFile(resolve(root,"work/parser-fixture.png"));
const richFixture=fixture.replace('Manage all projects in one place','<tspan font-size="22" fill="#646b75">本周完成 </tspan><tspan font-size="30" fill="#166c55" font-weight="700">24</tspan><tspan font-size="22" fill="#646b75"> 个项目，</tspan><tspan font-size="22" fill="#166c55" text-decoration="underline">查看详情</tspan>');
await sharp(Buffer.from(richFixture)).png().toFile(resolve(root,"work/rich-ui-fixture.png"));
await writeFile(resolve(root,"work/sample-project.json"),JSON.stringify(p,null,2));
console.log("PASS: schema validation, duplicate/cyclic rejection, rich-text runs, model units, literal Unicode/emoji variants and ZWJ recognition drafts; UI fixtures created.");
