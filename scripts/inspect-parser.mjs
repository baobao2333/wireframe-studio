import cvModule from "@techstark/opencv-js";
import sharp from "sharp";
const cv=await cvModule;
const {data,info}=await sharp("work/parser-fixture.png").ensureAlpha().raw().toBuffer({resolveWithObject:true});
const src=cv.matFromImageData({data:new Uint8ClampedArray(data),width:info.width,height:info.height});
for(const mode of ["canny","threshold"]){const gray=new cv.Mat(),edges=new cv.Mat(),contours=new cv.MatVector(),hierarchy=new cv.Mat();cv.cvtColor(src,gray,cv.COLOR_RGBA2GRAY);if(mode==="canny")cv.Canny(gray,edges,30,100,3,false);else cv.threshold(gray,edges,235,255,cv.THRESH_BINARY_INV);cv.findContours(edges,contours,hierarchy,cv.RETR_LIST,cv.CHAIN_APPROX_SIMPLE);const boxes=[];for(let i=0;i<contours.size();i++){const c=contours.get(i),r=cv.boundingRect(c),area=cv.contourArea(c);if(r.width>500||r.width>120&&r.height<80&&r.height>25)boxes.push({...r,coverage:Number((area/(r.width*r.height)).toFixed(2))});c.delete();}console.log(mode,boxes);gray.delete();edges.delete();contours.delete();hierarchy.delete();}src.delete();
