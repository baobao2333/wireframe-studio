import { net } from "electron";

function responseHeaders(values) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(values)) {
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

function responseWithUrl(body, options, url) {
  const response = new Response(body, options);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

// Public update downloads only. Redirect policy belongs to hot-update.mjs.
export async function electronFetch(input, init = {}) {
  if (init.redirect && init.redirect !== "manual") throw new TypeError("electronFetch only supports manual redirects");
  const request = new Request(input, { ...init, redirect: "manual" });
  if (!["GET", "HEAD"].includes(request.method)) throw new TypeError("electronFetch only supports GET and HEAD");
  if (!["http:", "https:"].includes(new URL(request.url).protocol)) throw new TypeError("electronFetch requires an HTTP or HTTPS URL");
  const { signal } = request;
  if (signal.aborted) throw signal.reason;

  return new Promise((resolve, reject) => {
    const outgoing = net.request({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      redirect: "manual",
      credentials: "omit",
      cache: request.cache,
    });
    let settled = false, ended = false, controller;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const fail = (error) => {
      if (ended) return;
      ended = true;
      cleanup();
      if (!settled) reject(error);
      else controller?.error(error);
      outgoing.abort();
    };
    const onAbort = () => fail(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    outgoing.on("error", fail);
    outgoing.on("abort", () => fail(signal.aborted ? signal.reason : new DOMException("The request was aborted", "AbortError")));
    // Electron 44 can emit the writable "close" before response headers arrive.
    // Only response end/error or an explicit abort completes this transaction.
    outgoing.once("redirect", (status, _method, redirectUrl, values) => {
      if (ended) return;
      try {
        const headers = responseHeaders(values);
        headers.set("location", redirectUrl);
        const response = responseWithUrl(null, { status, headers }, request.url);
        // Not following is intentional; Chromium's subsequent cancellation is not a download failure.
        settled = true;
        ended = true;
        cleanup();
        resolve(response);
        outgoing.abort();
      } catch (error) { fail(error); }
    });
    outgoing.once("response", (incoming) => {
      if (ended) return;
      const hasBody = request.method !== "HEAD" && ![204, 205, 304].includes(incoming.statusCode);
      const body = hasBody ? new ReadableStream({
        start(value) { controller = value; },
        cancel() {
          if (ended) return;
          ended = true;
          cleanup();
          outgoing.abort();
        },
      }) : null;
      incoming.once("end", () => {
        if (ended) return;
        ended = true;
        cleanup();
        controller?.close();
      });
      incoming.on("error", fail);
      incoming.once("aborted", () => fail(signal.aborted ? signal.reason : new Error("The update response was aborted")));
      try {
        const response = responseWithUrl(body, {
          status: incoming.statusCode,
          statusText: incoming.statusMessage,
          headers: responseHeaders(incoming.headers),
        }, request.url);
        settled = true;
        resolve(response);
        // Electron requires the end handler to be installed before the data handler.
        incoming.on("data", chunk => {
          if (ended || !controller) return;
          try { controller.enqueue(new Uint8Array(chunk)); } catch (error) { fail(error); }
        });
      } catch (error) { fail(error); }
    });
    try { outgoing.end(); } catch (error) { fail(error); }
  });
}
