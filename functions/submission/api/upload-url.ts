// POST /api/upload-url
// Body: { filename, contentType, size }
// Returns: { submissionId, uploadUrl, pendingName }
//
// Creates a new submission ID and initiates a Google Drive resumable upload
// session. The browser will PUT the file directly to the returned uploadUrl.
// That session URL is self-authenticating and valid for ~7 days.

import {
  GoogleApiError,
  generateSubmissionId,
  getAccessToken,
  initiateResumableUpload,
  safeFilePart,
  type GoogleEnv,
} from "../_shared/google";

type Env = GoogleEnv;

const MAX_SIZE = 5 * 1024 * 1024 * 1024; // 5 GB — safety cap
const ALLOWED_EXT = new Set(["mp4", "mov"]);

interface UploadUrlRequest {
  filename?: string;
  contentType?: string;
  size?: number;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  if (!env.GOOGLE_DRIVE_FOLDER_ID) {
    return jsonError(
      "Server misconfigured: GOOGLE_DRIVE_FOLDER_ID is not set",
      500,
    );
  }

  let body: UploadUrlRequest;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const rawFilename = (body.filename ?? "").trim();
  const contentType = (body.contentType ?? "").trim();
  const size = Number(body.size);

  if (!rawFilename) return jsonError("filename required", 400);
  if (!Number.isFinite(size) || size <= 0) {
    return jsonError("size must be a positive number", 400);
  }
  if (size > MAX_SIZE) {
    return jsonError(`File exceeds ${MAX_SIZE / 1024 ** 3} GB limit`, 413);
  }

  const ext = (rawFilename.split(".").pop() ?? "").toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return jsonError("Only .mp4 and .mov files are allowed", 400);
  }
  const canonicalMime = ext === "mp4" ? "video/mp4" : "video/quicktime";
  const finalMime = contentType || canonicalMime;

  const submissionId = generateSubmissionId();
  // Pending name is used until /api/finalize renames it to include team info.
  // Prefix with "__PENDING__" so the admin UI can distinguish un-finalized uploads.
  const pendingName = `__PENDING__${submissionId}_${safeFilePart(rawFilename, 80)}`;

  try {
    const accessToken = await getAccessToken(env);
    const uploadUrl = await initiateResumableUpload(
      accessToken,
      env.GOOGLE_DRIVE_FOLDER_ID,
      {
        name: pendingName,
        mimeType: finalMime,
        description: `Soulscape 2026 submission ${submissionId} (pending finalize)`,
        properties: {
          soulscape: "1",
          submissionId,
          status: "pending",
        },
      },
      size,
    );

    return json({
      submissionId,
      uploadUrl,
      pendingName,
    });
  } catch (err) {
    return handleError(err);
  }
};

export const onRequestOptions: PagesFunction<Env> = async () => {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Max-Age": "86400",
    },
  });
};

function handleError(err: unknown): Response {
  if (err instanceof GoogleApiError) {
    console.error("[upload-url] Google API error:", err.status, err.body);
    return jsonError(err.message, err.status >= 500 ? 502 : err.status);
  }
  console.error("[upload-url] Unexpected error:", err);
  return jsonError(
    err instanceof Error ? err.message : "Internal server error",
    500,
  );
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function jsonError(message: string, status = 400): Response {
  return json({ error: message }, status);
}
