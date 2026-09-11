export type UpdateState = {
  status: string;
  appVersion: string;
  currentVersion: string;
  availableVersion?: string | null;
  progress?: { percent: number; received: number; total: number };
  error?: { code: string; message: string } | null;
  rollbackReason?: string | null;
  pending?: boolean;
  native?: {
    version: string;
    filename: string;
    size: number;
    sha256: string;
    url: string;
  } | null;
};
export type NativeUpdateState = {
  status: string;
  version?: string;
  percent?: number;
  error?: string;
};
export type DesktopInfo = {
  version: string;
  rendererVersion: string;
  dataPath: string;
  projectPath: string | null;
  codex: { available: boolean; error?: string };
  updates: UpdateState;
  nativeUpdate: NativeUpdateState;
  repository: string;
  platform: string;
};
export type VisionJob = {
  status: string;
  message: string;
  elapsed: number;
  error: string;
  result: {
    title: string;
    summary: string;
    width: number;
    height: number;
    nodes: Record<string, unknown>[];
  };
};
export type OpenedProject = { name: string; content: string; path: string };
export interface DesktopApi {
  info(): Promise<DesktopInfo>;
  openImage(): Promise<{
    name: string;
    type: string;
    data: ArrayBuffer;
  } | null>;
  storageGet(key: string): Promise<unknown>;
  storageSet(key: string, value: unknown): Promise<void>;
  openProject(): Promise<{
    name: string;
    content: string;
    path: string;
  } | null>;
  acceptProject(path: string | null): Promise<void>;
  saveProject(
    project: unknown,
    saveAs: boolean,
  ): Promise<{ path: string } | null>;
  saveExport(
    filename: string,
    data: ArrayBuffer,
  ): Promise<{ path: string } | null>;
  revealFile(path: string): Promise<void>;
  copyText(text: string): Promise<void>;
  visionStart(input: {
    image: string;
    width: number;
    name: string;
  }): Promise<{ id: string }>;
  visionGet(id: string): Promise<VisionJob>;
  visionCancel(id: string): Promise<void>;
  updateCheck(): Promise<UpdateState>;
  updateDownload(): Promise<UpdateState>;
  updateApply(): Promise<void>;
  nativeUpdateDownload(): Promise<void>;
  nativeUpdateApply(): Promise<void>;
  rendererReady(): void;
  closeReady(): void;
  onCommand(listener: (command: string) => void): () => void;
  onProject(listener: (file: OpenedProject) => void): () => void;
  onUpdate(listener: (state: UpdateState) => void): () => void;
}
declare global {
  interface Window {
    wireframeDesktop?: DesktopApi;
  }
}
export const desktop =
  typeof window !== "undefined" ? window.wireframeDesktop : undefined;
export async function copyText(text: string) {
  if (desktop) await desktop.copyText(text);
  else await navigator.clipboard.writeText(text);
}
