"use client";
import { useEffect, useRef, useState } from "react";
import {
  ImagePlus,
  ScanLine,
  Loader2,
  ShieldCheck,
  AlertCircle,
  Check,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { readImage, parseImage } from "@/lib/image-parser";
import type { Project } from "@/lib/wireframe";
import { modelImage } from "@/lib/model-client";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function ImportDialog({
  open,
  onOpenChange,
  onImport,
  initialImage,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onImport: (p: Project) => void;
  initialImage?: Project["reference"];
}) {
  const [image, setImage] = useState<{
    src: string;
    width: number;
    height: number;
    name: string;
  } | null>(initialImage || null);
  const [width, setWidth] = useState(initialImage?.width || 1120),
    [language, setLanguage] = useState<"eng" | "chi_sim+eng">("chi_sim+eng");
  const [mode, setMode] = useState("model");
  const [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0),
    [status, setStatus] = useState(""),
    [error, setError] = useState(""),
    [result, setResult] = useState<Project | null>(null);
  const fileRef = useRef<HTMLInputElement>(null),
    controller = useRef<AbortController | null>(null),
    fileSequence = useRef(0);
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  async function select(file: File) {
    const seq = ++fileSequence.current;
    setError("");
    setResult(null);
    try {
      const next = await readImage(file);
      if (seq !== fileSequence.current) return;
      setImage(next);
      setWidth(Math.max(240, Math.min(1600, next.width)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  async function run() {
    if (!image) return;
    if (!Number.isInteger(width) || width < 240 || width > 6000) {
      setError("目标宽度须为 240 至 6000 px 的整数");
      return;
    }
    setBusy(true);
    setError("");
    setResult(null);
    setProgress(0);
    controller.current = new AbortController();
    const c = controller.current;
    setStatus(mode === "model" ? "连接本机 Codex" : "加载 OCR");
    try {
      const project =
        mode === "model"
          ? await modelImage(image, width, c.signal, setStatus)
          : await parseImage(image, {
              width,
              language,
              signal: c.signal,
              onProgress: (v, label) => {
                setProgress((p) => Math.max(p, Math.round(v)));
                setStatus(label);
              },
            });
      if (!c.signal.aborted) setResult(project);
    } catch (e) {
      if (!c.signal.aborted)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const close = (v: boolean) => {
    if (!v) {
      controller.current?.abort();
      fileSequence.current++;
    }
    onOpenChange(v);
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="studio-dialog import-dialog">
        <div className="dialog-eyebrow">
          <ScanLine size={16} />
          图片转线框
        </div>
        <DialogTitle>从现有界面开始</DialogTitle>
        <DialogDescription>
          识别结果是初稿。文字、组件类型和尺寸需要你确认。
        </DialogDescription>
        <Tabs
          value={mode}
          onValueChange={(v) => {
            if (!busy) {
              setMode(v);
              setResult(null);
            }
          }}
        >
          <TabsList className="recognition-modes">
            <TabsTrigger value="model" disabled={busy}>
              Codex 视觉模型
            </TabsTrigger>
            <TabsTrigger value="ocr" disabled={busy}>
              本地 OCR · 基础
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <input
          className="sr-only"
          ref={fileRef}
          aria-label="选择界面图片"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => {
            if (e.target.files?.[0]) void select(e.target.files[0]);
            e.target.value = "";
          }}
        />
        <button
          className={`image-drop ${image ? "has-image" : ""}`}
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (!busy && e.dataTransfer.files[0])
              void select(e.dataTransfer.files[0]);
          }}
        >
          {image ? (
            <>
              <img src={image.src} alt="待解析的界面图片" />
              <span className="image-file-label">
                {image.name}{" "}
                <span>
                  {image.width} × {image.height}
                </span>
              </span>
            </>
          ) : (
            <>
              <ImagePlus size={30} />
              <strong>选择或拖入界面截图</strong>
              <span>PNG / JPG / WebP · 最大 20 MB</span>
            </>
          )}
        </button>
        <div className="import-options">
          {mode === "ocr" ? (
            <label>
              识别语言
              <select
                aria-label="识别语言"
                disabled={busy}
                value={language}
                onChange={(e) => {
                  setLanguage(e.target.value as typeof language);
                  setResult(null);
                }}
              >
                <option value="chi_sim+eng">中文 + English</option>
                <option value="eng">English</option>
              </select>
            </label>
          ) : (
            <div className="model-connection">
              <strong>本机 Codex</strong>
              <span>当前登录 · 组件树与富文本</span>
            </div>
          )}
          <label>
            画布宽度 · px
            <input
              aria-label="目标画布宽度"
              type="number"
              min={240}
              max={6000}
              disabled={busy}
              value={width}
              onChange={(e) => {
                setWidth(Number(e.target.value));
                setResult(null);
              }}
            />
          </label>
        </div>
        {busy && (
          <div className="parse-progress">
            <div>
              <Loader2 size={15} className="spin" />
              <span>{status}</span>
              {mode === "ocr" && <strong>{progress}%</strong>}
            </div>
            {mode === "ocr" && <Progress value={progress} />}
            <button
              className="cancel-parse"
              onClick={() => controller.current?.abort()}
            >
              取消解析
            </button>
          </div>
        )}
        {error && (
          <div className="error-message" role="alert">
            <AlertCircle size={17} />
            <span>{error}</span>
          </div>
        )}
        {result && (
          <div className="parse-result" role="status">
            <Check size={18} />
            <div>
              <strong>识别到 {result.nodes.length} 个可编辑组件</strong>
              <span>
                富文本{" "}
                {result.nodes.filter((n) => n.type === "richtext").length} ·
                容器 {result.nodes.filter((n) => n.type === "frame").length} ·
                全部保留为待确认
              </span>
            </div>
          </div>
        )}
        <div className="dialog-footer-row">
          <span className="privacy-note">
            <ShieldCheck size={14} />
            {mode === "model"
              ? "图片将通过 Codex 发送给模型"
              : "图片仅在本地解析"}
          </span>
          {result ? (
            <button
              className="command primary"
              onClick={() => {
                onImport(result);
                setResult(null);
                setImage(null);
              }}
            >
              应用到新画布
            </button>
          ) : (
            <button
              className="command primary"
              disabled={!image || busy}
              onClick={() => void run()}
            >
              {busy ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <ScanLine size={16} />
              )}
              生成线框图
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
