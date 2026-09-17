import type { OperationEvent, OperationRecord, OperationLogStatus } from "./operation-log";

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
  publisher?: {
    name: string;
    status: "self-signed" | "unverified" | "development";
    error?: string;
  };
};
export type VisionProgress = {
  stage: "starting" | "recognizing" | "receiving" | "validating" | "complete";
  activityAgeMs: number | null;
  eventCount: number;
  outputChars: number;
  nodeCount: number | null;
  timeoutMs: number;
  warning: string | null;
};
export type VisionJob = {
  status: string;
  message: string;
  elapsed: number;
  progress?: VisionProgress;
  error: string;
  result: {
    title: string;
    summary: string;
    width: number;
    height: number;
    background: string;
    nodes: Record<string, unknown>[];
  };
};
export type OpenedProject = { name: string; content: string; path: string };
export type CodexControlState = {
  enabled: boolean; ready: boolean; connected: boolean; busy: boolean;
  lastCommand?: { summary: string; at: string; status: "applied" | "failed" };
  error?: string;
};
export type CodexControlRequest = { id: string; deadline: number; tool: string; args: Record<string, unknown> };
export interface DesktopApi {
  info(): Promise<DesktopInfo>;
  logAppend(event: OperationEvent): Promise<OperationLogStatus>;
  logStatus(): Promise<OperationLogStatus>;
  logRecent(limit?: number): Promise<OperationRecord[]>;
  logFlush(): Promise<void>;
  logReveal(): Promise<void>;
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
  rendererReady(version: string): void;
  closeReady(): void;
  onCommand(listener: (command: string) => void): () => void;
  onProject(listener: (file: OpenedProject) => void): () => void;
  onUpdate(listener: (state: UpdateState) => void): () => void;
  controlStatus(): Promise<CodexControlState>;
  controlConfigure(enabled: boolean): Promise<CodexControlState>;
  controlConnect(): Promise<CodexControlState>;
  controlResult(id: string, result: Record<string, unknown>): Promise<boolean>;
  onControlRequest(listener: (request: CodexControlRequest) => void): () => void;
  onControlState(listener: (state: CodexControlState) => void): () => void;
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
