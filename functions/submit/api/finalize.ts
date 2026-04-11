// POST /api/finalize
// Body: { submissionId, driveFileId, metadata }
// Returns: { ok, submissionId, submittedAt, driveFileId, metadataFileId, viewUrl }
//
// Runs after the browser's direct PUT to the Drive resumable upload URL
// completes. We verify the file exists, rename it to include team info
// (so the Drive folder is browsable by humans), and write a metadata.json
// sidecar file in the same folder capturing team/specs/attestations.

import {
  GoogleApiError,
  createJsonFile,
  getAccessToken,
  getFileMetadata,
  renameFile,
  safeFilePart,
  type GoogleEnv,
} from "../_shared/google";

type Env = GoogleEnv;

interface FinalizeRequest {
  submissionId?: string;
  driveFileId?: string;
  metadata?: {
    teamId?: string;
    discord?: string;
    email?: string;
    title?: string;
    logline?: string;
    tool?: string;
    filename?: string;
    specs?: {
      size?: number;
      width?: number;
      height?: number;
      duration?: number;
      fps?: number;
    };
    attestations?: Record<string, boolean>;
  };
}

const SUBMISSION_ID_RE = /^SSF26-[A-Z0-9]+-[A-Z0-9]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  if (!env.GOOGLE_DRIVE_FOLDER_ID) {
    return jsonError(
      "Server misconfigured: GOOGLE_DRIVE_FOLDER_ID is not set",
      500,
    );
  }

  let body: FinalizeRequest;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const submissionId = (body.submissionId ?? "").trim();
  const driveFileId = (body.driveFileId ?? "").trim();
  const metadata = body.metadata ?? {};

  if (!SUBMISSION_ID_RE.test(submissionId)) {
    return jsonError("Invalid submission ID format", 400);
  }
  if (!driveFileId) {
    return jsonError("driveFileId required", 400);
  }

  const required: Array<[string, string | undefined]> = [
    ["teamId", metadata.teamId],
    ["discord", metadata.discord],
    ["email", metadata.email],
    ["title", metadata.title],
    ["tool", metadata.tool],
  ];
  for (const [key, value] of required) {
    if (!value || !String(value).trim()) {
      return jsonError(`Missing metadata.${key}`, 400);
    }
  }
  if (!EMAIL_RE.test(metadata.email!)) {
    return jsonError("Invalid email", 400);
  }

  try {
    const accessToken = await getAccessToken(env);

    // Verify the uploaded file exists in the correct folder
    const fileMeta = await getFileMetadata(accessToken, driveFileId);
    if (!fileMeta.parents?.includes(env.GOOGLE_DRIVE_FOLDER_ID)) {
      return jsonError(
        "Uploaded file is not in the expected folder — reject as tampered",
        400,
      );
    }
    if (!fileMeta.size || Number(fileMeta.size) === 0) {
      return jsonError(
        "Uploaded file is empty — upload may have been interrupted",
        400,
      );
    }

    // Rename the video file: <submissionId>_<teamId>_<title>.<ext>
    const teamId = safeFilePart(String(metadata.teamId).trim(), 40);
    const title = safeFilePart(String(metadata.title).trim(), 60);
    const origName = fileMeta.name ?? "";
    const ext = (origName.split(".").pop() ?? "mp4").toLowerCase();
    const newName = `${submissionId}_${teamId}_${title}.${ext}`;
    const renamed = await renameFile(accessToken, driveFileId, newName);

    // Write metadata.json sidecar
    const submittedAt = new Date().toISOString();
    const manifest = {
      submissionId,
      submittedAt,
      driveFileId,
      driveFileName: renamed.name,
      driveViewLink: renamed.webViewLink ?? null,
      videoSize: Number(fileMeta.size),
      videoMd5: fileMeta.md5Checksum ?? null,
      team: {
        teamId: String(metadata.teamId).trim(),
        discord: String(metadata.discord).trim(),
        email: String(metadata.email).trim(),
      },
      film: {
        title: String(metadata.title).trim(),
        logline: metadata.logline ? String(metadata.logline).trim() : "",
        primaryTool: String(metadata.tool).trim(),
      },
      source: {
        filename: metadata.filename ?? null,
        specs: metadata.specs ?? null,
      },
      attestations: metadata.attestations ?? {},
      clientIp: request.headers.get("cf-connecting-ip") ?? null,
      userAgent: request.headers.get("user-agent") ?? null,
    };

    const metadataFileName = `${submissionId}_${teamId}_metadata.json`;
    const metadataFile = await createJsonFile(
      accessToken,
      env.GOOGLE_DRIVE_FOLDER_ID,
      metadataFileName,
      manifest,
    );

    return json({
      ok: true,
      submissionId,
      submittedAt,
      driveFileId,
      driveFileName: renamed.name,
      metadataFileId: metadataFile.id,
      viewUrl: renamed.webViewLink ?? null,
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
    console.error("[finalize] Google API error:", err.status, err.body);
    return jsonError(err.message, err.status >= 500 ? 502 : err.status);
  }
  console.error("[finalize] Unexpected error:", err);
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
