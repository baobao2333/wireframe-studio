import { readFile,writeFile } from "node:fs/promises";
const image="data:image/png;base64,"+(await readFile("work/parser-fixture.png")).toString("base64");
const response=await fetch("http://127.0.0.1:5187/api/vision/jobs",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({image,width:1120,name:"parser-fixture.png"})});
const result=await response.json();if(!response.ok)throw Error(JSON.stringify(result));await writeFile("work/vision-job.json",JSON.stringify(result));console.log(result);
