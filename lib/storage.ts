import { get as getBrowser, set as setBrowser } from "idb-keyval";
import { desktop } from "./desktop";

export function get(key: string) {
  return desktop ? desktop.storageGet(key) : getBrowser(key);
}
export function set(key: string, value: unknown) {
  return desktop ? desktop.storageSet(key, value) : setBrowser(key, value);
}
