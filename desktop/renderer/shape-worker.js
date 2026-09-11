function detectShapes(cv, imageData) {
  const src = cv.matFromImageData(imageData), gray = new cv.Mat(), edges = new cv.Mat(), contours = new cv.MatVector(), hierarchy = new cv.Mat();
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const boxes = [];
    for (const mode of ["edge", "filled"]) {
      if (mode === "edge") cv.Canny(gray, edges, 30, 100, 3, false);
      else cv.threshold(gray, edges, 235, 255, cv.THRESH_BINARY_INV);
      cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < contours.size(); i++) {
        const contour = contours.get(i);
        try {
          const r = cv.boundingRect(contour);
          const area = r.width * r.height, coverage = Math.abs(cv.contourArea(contour)) / area;
          const line = r.width > imageData.width * .12 && r.height <= 4;
          const rect = area > 400 && coverage > .72 && r.width > 28 && r.height > 14;
          if ((line || rect) && area < imageData.width * imageData.height * .92) boxes.push({ x: r.x, y: r.y, w: r.width, h: r.height });
        } finally { contour.delete(); }
      }
    }
    const unique = [];
    boxes.sort((a, b) => b.w * b.h - a.w * a.h).forEach(b => {
      if (!unique.some(a => Math.abs(a.x - b.x) <= 5 && Math.abs(a.y - b.y) <= 5 && Math.abs(a.w - b.w) <= 10 && Math.abs(a.h - b.h) <= 10)) unique.push(b);
    });
    return unique.slice(0, 250);
  } finally { src.delete(); gray.delete(); edges.delete(); contours.delete(); hierarchy.delete(); }
}

self.onmessage = async ({ data }) => {
  try {
    const { width, height, pixels } = data || {};
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 40000000
      || !(pixels instanceof ArrayBuffer) || pixels.byteLength !== width * height * 4) throw Error("图片像素数据无效");
    self.importScripts(new URL("./opencv.js", self.location.href).href);
    const cv = await self.cv;
    if (!cv?.Mat) throw Error("OpenCV 未完成初始化");
    self.postMessage({ type: "ready" });
    const boxes = detectShapes(cv, { width, height, data: new Uint8ClampedArray(pixels) });
    self.postMessage({ type: "result", boxes });
  } catch (error) {
    self.postMessage({ type: "error", error: `图形解析失败：${error instanceof Error ? error.message : String(error)}` });
  }
};
