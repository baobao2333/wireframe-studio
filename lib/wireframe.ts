import { z } from "zod";

export const kinds = ["text", "richtext", "button", "input", "select", "image", "frame", "line", "checkbox", "radio", "switch", "tag", "avatar", "icon", "progress", "tabs", "table", "list"] as const;
export type Kind = typeof kinds[number];
export const kindNames: Record<Kind, string> = { text: "文字", richtext: "富文本", button: "按钮", input: "输入框", select: "下拉框", image: "图片", frame: "容器", line: "分隔线", checkbox: "复选框", radio: "单选框", switch: "开关", tag: "标签", avatar: "头像", icon: "图标", progress: "进度条", tabs: "导航标签", table: "表格", list: "列表" };
const coord = z.number().finite().min(-10000).max(20000);
const color = z.string().regex(/^(#[0-9a-fA-F]{6}|none)$/);
export const richRunSchema = z.object({ text:z.string().max(10000),fontSize:z.number().finite().min(8).max(160),fontWeight:z.enum(["400","500","600","700"]),color,italic:z.boolean(),underline:z.boolean() });
export type RichRun=z.infer<typeof richRunSchema>;
export const nodeSchema = z.object({
  id: z.string().min(1).max(100), name: z.string().max(200), type: z.enum(kinds),
  x: coord, y: coord, w: z.number().finite().min(4).max(6000), h: z.number().finite().min(2).max(6000),
  text: z.string().max(10000), fontSize: z.number().finite().min(8).max(160),
  fontWeight: z.enum(["400", "500", "600", "700"]), align: z.enum(["left", "center", "right"]),
  lineHeight: z.number().finite().min(1).max(3), fill: color, stroke: color, color,
  radius: z.number().min(0).max(3000), strokeWidth: z.number().min(0).max(12),
  textStroke: color.optional(), textStrokeWidth: z.number().finite().min(0).max(12).optional(),
  textLayout: z.enum(["wrap", "source-lines"]).optional(),
  priority: z.enum(["primary", "secondary", "tertiary"]), parentId: z.string().max(100).nullable(),
  note: z.string().max(10000), locked: z.boolean(), hidden: z.boolean(),
  origin: z.enum(["manual", "detected"]), reviewed: z.boolean(), confidence: z.number().min(0).max(100).nullable(),
  runs: z.array(richRunSchema).max(200).optional(),
  items: z.array(z.string().max(2000)).max(100).optional(),
  rows: z.array(z.array(z.string().max(2000)).max(20)).max(50).optional(),
  value: z.number().min(0).max(1).optional(),
  icon: z.enum(["search","home","user","bell","settings","menu","chevron-right","plus","star","heart","check","close"]).optional(),
});
export type WNode = z.infer<typeof nodeSchema>;
export const projectSchema = z.object({
  version: z.literal(1), name: z.string().min(1).max(200),
  width: z.number().int().min(240).max(6000), height: z.number().int().min(240).max(6000),
  background: color, grid: z.number().int().min(1).max(64), notes: z.string().max(20000),
  nodes: z.array(nodeSchema).max(1000),
  reference: z.object({ src: z.string().max(30000000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/), name: z.string().max(300), width: z.number().positive(), height: z.number().positive() }).nullable(),
});
export type Project = z.infer<typeof projectSchema>;
export const uid = () => crypto.randomUUID();
export function makeNode(type: Kind, patch: Partial<WNode> = {}): WNode {
  const sizes: Record<Kind, [number, number]> = { text:[220,36],richtext:[320,80],button:[152,44],input:[280,44],select:[240,44],image:[280,170],frame:[320,220],line:[280,2],checkbox:[200,28],radio:[200,28],switch:[44,26],tag:[88,28],avatar:[48,48],icon:[24,24],progress:[280,10],tabs:[360,44],table:[520,160],list:[320,144] };
  const texts:Record<Kind,string>={text:"新的文字",richtext:"重点内容，与补充说明。",button:"确认",input:"请输入内容",select:"请选择",image:"图片",frame:"",line:"",checkbox:"选项内容",radio:"单选选项",switch:"",tag:"标签",avatar:"AB",icon:"",progress:"",tabs:"",table:"",list:""};
  return { id:uid(),type,name:kindNames[type],x:48,y:48,w:sizes[type][0],h:sizes[type][1],text:texts[type],fontSize:16,fontWeight:"400",align:["button","tag","image","avatar"].includes(type)?"center":"left",lineHeight:1.5,fill:["text","richtext","line","checkbox","radio","icon"].includes(type)?"none":type==="button"?"#27292e":type==="image"?"#f3f4f5":"#ffffff",stroke:["text","richtext","checkbox","radio","switch","icon","progress"].includes(type)?"none":"#c9ccd1",color:type==="button"?"#ffffff":"#34363c",radius:["text","richtext","line","checkbox"].includes(type)?0:4,strokeWidth:1,priority:type==="button"?"primary":"secondary",parentId:null,note:"",locked:false,hidden:false,origin:"manual",reviewed:true,confidence:null,
    runs:type==="richtext"?[{text:"重点内容",fontSize:22,fontWeight:"700",color:"#34363c",italic:false,underline:false},{text:"，与补充说明。",fontSize:16,fontWeight:"400",color:"#777d85",italic:false,underline:false}]:[],
    items:type==="tabs"?["概览","项目","设置"]:type==="list"?["第一项内容","第二项内容","第三项内容"]:[],rows:type==="table"?[["名称","状态","负责人"],["项目 A","进行中","张三"],["项目 B","已完成","李四"]]:[],value:type==="switch"||type==="radio"?1:.5,icon:"search",...patch };
}
export function blankProject(): Project { return { version: 1, name: "未命名界面", width: 1200, height: 800, background: "#ffffff", grid: 8, notes: "", nodes: [], reference: null }; }
export function sampleProject(): Project {
  const p = blankProject(); p.name = "项目概览 · 界面规范"; p.width = 1120; p.height = 760;
  const header = makeNode("frame", { name: "顶部导航", x: 0, y: 0, w: 1120, h: 72, radius: 0, stroke: "#e2e4e7", priority: "tertiary" });
  const panel = makeNode("frame", { name: "项目列表区域", x: 40, y: 242, w: 1040, h: 384, stroke: "#d7d9dd", radius: 4 });
  p.nodes = [header, panel,
    makeNode("text", { name: "品牌名称", text: "WORKSPACE", x: 32, y: 23, w: 200, h: 30, fontSize: 18, fontWeight: "700", parentId: header.id }),
    makeNode("text", { name: "导航菜单", text: "概览          项目          成员", x: 322, y: 25, w: 410, h: 26, fontSize: 14, color: "#71747a", parentId: header.id, priority: "tertiary" }),
    makeNode("tag", { text: "我的空间", name: "空间入口", x: 986, y: 22, w: 96, h: 28, fontSize: 12, parentId: header.id }),
    makeNode("text", { name: "页面标题", text: "项目概览", x: 40, y: 112, w: 520, h: 50, fontSize: 32, fontWeight: "700", priority: "primary", note: "页面唯一一级标题；与列表左边缘对齐。" }),
    makeNode("text", { name: "页面摘要", text: "所有正在进行的项目，集中在这里。", x: 40, y: 170, w: 630, h: 28, fontSize: 16, color: "#71747a" }),
    makeNode("button", { name: "新建项目", text: "+  新建项目", x: 932, y: 125, w: 148, h: 44, fontSize: 14, fontWeight: "500", note: "页面唯一主操作。" }),
    makeNode("text", { name: "列表标题", text: "最近项目", x: 64, y: 263, w: 300, h: 30, fontSize: 18, fontWeight: "600", parentId: panel.id }),
    makeNode("input", { name: "搜索项目", text: "搜索项目…", x: 804, y: 258, w: 252, h: 36, fontSize: 13, color: "#8b8d93", parentId: panel.id }),
    makeNode("line", { name: "列表分隔线", x: 40, y: 313, w: 1040, h: 2, stroke: "#e2e4e7", parentId: panel.id }),
  ];
  ["品牌官网改版", "移动端工作台", "设计系统整理"].forEach((text, i) => {
    const y = 343 + i * 90;
    p.nodes.push(makeNode("image", { name: `项目 ${i + 1} 缩略图`, text: "", x: 64, y, w: 64, h: 56, parentId: panel.id }),
      makeNode("text", { name: text, text, x: 150, y: y + 1, w: 350, h: 26, fontSize: 16, fontWeight: "500", parentId: panel.id }),
      makeNode("text", { name: "项目日期", text: `更新于 09 / 0${9 - i}`, x: 150, y: y + 29, w: 350, h: 22, fontSize: 12, color: "#85888e", parentId: panel.id, priority: "tertiary" }),
      makeNode("tag", { name: "项目状态", text: i === 2 ? "已完成" : "进行中", x: 804, y: y + 12, w: 76, h: 28, fontSize: 12, parentId: panel.id }),
      makeNode("text", { name: "项目入口", text: "查看 →", x: 970, y: y + 12, w: 86, h: 28, fontSize: 13, align: "right", parentId: panel.id, priority: "tertiary" }));
  });
  p.nodes.push(makeNode("text", { name: "页脚", text: "3 个项目", x: 40, y: 650, w: 500, h: 24, fontSize: 12, color: "#85888e", priority: "tertiary" }));
  p.notes = "保持清晰的信息层级。页面标题 32px，分区标题 18px，正文 16px，辅助信息 12px。间距以 8px 为基准。";
  return p;
}
export function validateProject(raw: unknown): Project {
  const p = projectSchema.parse(raw); const ids = new Set(p.nodes.map(n => n.id));
  if (ids.size !== p.nodes.length) throw new Error("组件 ID 重复");
  for (const node of p.nodes) {
    const seen = new Set([node.id]); let parent = node.parentId;
    while (parent) { const found = p.nodes.find(n => n.id === parent); if (!found) throw new Error(`组件“${node.name}”引用了不存在的父级 ${parent}`); if(found.type !== "frame") throw new Error(`组件“${node.name}”的父级“${found.name}”不是容器`); if(seen.has(parent)) throw new Error(`组件“${node.name}”的父级存在循环`); seen.add(parent); parent = found.parentId; }
  }
  return p;
}

export type RecognitionResult = {
  title: string;
  summary: string;
  width: number;
  height: number;
  background: string;
  nodes: Record<string, unknown>[];
};

export function recognitionProject(result: RecognitionResult, reference: Project["reference"], targetWidth: number): Project {
  const project = {
    ...blankProject(), name: result.title, width: result.width, height: result.height, background: result.background,
    notes: result.summary, reference,
    nodes: result.nodes.map((node) => makeNode(node.type as Kind, {
      ...node, origin: "detected", reviewed: false, locked: false, hidden: false,
    })),
  };
  let checked: Project;
  try {
    checked = validateProject(project);
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    const details = error.issues.slice(0, 5).map((issue) => {
      const index = issue.path[0] === "nodes" && typeof issue.path[1] === "number" ? issue.path[1] : null;
      const node = index === null ? null : project.nodes[index];
      const field = issue.path.slice(index === null ? 0 : 2).join(".");
      let actual: unknown = project;
      for (const key of issue.path) {
        actual = actual !== null && typeof actual === "object" ? (actual as Record<string | number, unknown>)[key] : undefined;
      }
      const value = JSON.stringify(actual)?.slice(0, 120) ?? "缺失";
      const location = node ? `第 ${index! + 1} 个组件“${node.name}”的 ${field}` : field;
      const rule = field === "value" ? "必须在 0～1 之间；它表示进度或控件状态，页面数字应放在 text 中"
        : field.endsWith("fontSize") ? "字号必须在 8～160 px 之间" : issue.message;
      return `${location}=${value}：${rule}`;
    });
    throw new Error(`识别结果未通过校验：${details.join("；")}。原画布未修改。`);
  }
  if (checked.width !== targetWidth) throw new Error("模型返回的画布尺寸不一致，请重试");
  for (const node of checked.nodes) {
    if (node.type === "richtext" && node.runs?.map((run) => run.text).join("") !== node.text)
      throw new Error(`富文本内容不一致：${node.name}`);
  }
  return checked;
}
