import { refineRecognitionColors } from "./recognition-colors";
import { refineRecognitionTypography } from "./recognition-typography";
import { validateProject, type Project } from "./wireframe";

export async function refineRecognitionDraft(project: Project, signal?: AbortSignal): Promise<Project> {
  const reference = project.reference;
  if (!reference) throw Error("原图不可用，无法校准颜色和文字排版");
  signal?.throwIfAborted();
  const image = new Image();
  image.src = reference.src;
  await image.decode();
  signal?.throwIfAborted();
  if (image.naturalWidth !== reference.width || image.naturalHeight !== reference.height)
    throw Error("原图尺寸与工程记录不一致，未应用校准结果");
  if (image.naturalWidth * image.naturalHeight > 32000000)
    throw Error("原图超过 3200 万像素，请裁剪后再识别");
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  try {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw Error("原图颜色取样环境不可用");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const colored = refineRecognitionColors(project, pixels);
    signal?.throwIfAborted();
    return validateProject(await refineRecognitionTypography(colored, signal));
  } finally { canvas.width = 0; canvas.height = 0; }
}
