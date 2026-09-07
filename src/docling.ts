import { config } from "./config.js";

export interface ConvertRequest {
  filename: string;
  contentType: string;
  content: Buffer;
}

export type Conversion =
  | { ok: true; filename: string; markdown: string }
  | { ok: false; filename: string; reason: string };

/** Shape of a docling-serve /v1/convert/source response (the parts we read). */
interface DoclingResponse {
  document?: { md_content?: string };
  status?: string;
  errors?: unknown[];
}

const RETRYABLE_STATUS = (status: number): boolean =>
  status >= 500 || status === 429;

function describe(error: unknown): string {
  if (error instanceof Error) {
    // AbortSignal.timeout rejects with a TimeoutError DOMException.
    return error.name === "TimeoutError"
      ? `timed out after ${config.doclingTimeoutMs}ms`
      : error.message;
  }
  return String(error);
}

async function postOnce(request: ConvertRequest): Promise<string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (config.doclingApiKey) headers["X-Api-Key"] = config.doclingApiKey;

  const response = await fetch(`${config.doclingUrl}/v1/convert/source`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(config.doclingTimeoutMs),
    body: JSON.stringify({
      options: {
        to_formats: ["md"],
        do_ocr: true,
        image_export_mode: "placeholder",
      },
      // One file per request: docling returns a zip archive for multiple sources.
      sources: [
        {
          kind: "file",
          base64_string: request.content.toString("base64"),
          filename: request.filename,
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    const error = new Error(`docling responded ${response.status}: ${body}`);
    if (RETRYABLE_STATUS(response.status)) error.name = "RetryableError";
    throw error;
  }

  const payload = (await response.json()) as DoclingResponse;

  // docling answers 200 with status "failure" when it cannot read the document.
  if (payload.status === "failure") {
    throw new Error(
      `docling status=failure ${JSON.stringify(payload.errors ?? []).slice(
        0,
        200
      )}`
    );
  }

  const markdown = payload.document?.md_content;
  if (typeof markdown !== "string" || markdown.length === 0) {
    throw new Error(
      `docling returned no markdown (status=${payload.status ?? "unknown"})`
    );
  }
  return markdown;
}

/** Converts one document to Markdown. Never throws — failures come back as data. */
export async function convertToMarkdown(
  request: ConvertRequest
): Promise<Conversion> {
  if (!config.doclingUrl) {
    return {
      ok: false,
      filename: request.filename,
      reason: "DOCLING_URL is not configured",
    };
  }
  if (request.content.byteLength > config.maxAttachmentBytes) {
    return {
      ok: false,
      filename: request.filename,
      reason: `too large (${request.content.byteLength} bytes > MAX_ATTACHMENT_BYTES)`,
    };
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return {
        ok: true,
        filename: request.filename,
        markdown: await postOnce(request),
      };
    } catch (error) {
      const retryable =
        error instanceof Error &&
        (error.name === "RetryableError" || error.name === "TimeoutError");
      if (!retryable || attempt === 2) {
        return {
          ok: false,
          filename: request.filename,
          reason: describe(error),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  /* c8 ignore next */
  return { ok: false, filename: request.filename, reason: "unreachable" };
}

/** Converts a batch with bounded concurrency, preserving input order. */
export async function convertAll(
  requests: ConvertRequest[]
): Promise<Conversion[]> {
  const results: Conversion[] = new Array(requests.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < requests.length) {
      const index = next++;
      results[index] = await convertToMarkdown(
        requests[index] as ConvertRequest
      );
    }
  };

  const lanes = Math.max(
    1,
    Math.min(config.doclingConcurrency, requests.length)
  );
  await Promise.all(Array.from({ length: lanes }, worker));
  return results;
}
