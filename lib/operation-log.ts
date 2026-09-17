import type { z } from "zod";
import { operationLogEventSchema, operationLogRecordSchema } from "../control/operation-log-schema.mjs";

export type OperationEvent = z.infer<typeof operationLogEventSchema>;
export type OperationRecord = z.infer<typeof operationLogRecordSchema>;
export type OperationLogStatus = {
  sessionId: string;
  sequence: number;
  closed: boolean;
  error: string | null;
};

export function createOperationRecorder(
  append: (event: OperationEvent) => Promise<unknown>,
  onError: () => void,
) {
  const pending = new Set<Promise<void>>();
  let warned = false;
  const warn = () => { if (!warned) { warned = true; onError(); } };
  return {
    record(event: OperationEvent) {
      if (pending.size >= 256) { warn(); return; }
      const task = Promise.resolve().then(() => append(event)).then(() => {}, warn);
      pending.add(task);
      void task.finally(() => pending.delete(task));
    },
    async flush() { while (pending.size) await Promise.all([...pending]); },
  };
}
