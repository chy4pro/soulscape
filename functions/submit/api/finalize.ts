// POST /api/finalize
// Body: { submissionId, driveFileId?, pendingName?, metadata }
// Returns: { ok, submissionId, submittedAt, driveFileId, metadataFileId, viewUrl }
//
// Runs after the browser's direct PUT to the Drive resumable upload URL
// completes. We verify the file exists, rename it to include team info
// (so the Drive folder is browsable by humans), and write a metadata.json
// sidecar file in the same folder capturing team/specs/attestations.
//
// The client passes driveFileId (parsed from the Drive PUT response body)
// when available. If the browser's XHR fired .onerror at the end of
// upload (known CORS edge case where the bytes were delivered but the
// response couldn't be read), driveFileId may be missing; we then fall
// back to pendingName lookup against the folder to find the just-
// uploaded file.

import {
  GoogleApiError,
  appendSubmissionRow,
  createJsonFile,
  findFileByName,
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
  pendingName?: string;
  metadata?: {
    teamId?: string;
    discord?: string;
    email?: string;
    title?: string;
    description?: string;
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
  let driveFileId = (body.driveFileId ?? "").trim();
  const pendingName = (body.pendingName ?? "").trim();
  const metadata = body.metadata ?? {};

  if (!SUBMISSION_ID_RE.test(submissionId)) {
    return jsonError("Invalid submission ID format", 400);
  }
  if (!driveFileId && !pendingName) {
    return jsonError("driveFileId or pendingName required", 400);
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

    // Fallback path: if driveFileId is missing (because browser XHR
    // fired .onerror at 100% due to Drive response CORS), look up the
    // file by the pending name we gave it during initiate.
    if (!driveFileId && pendingName) {
      const found = await findFileByName(
        accessToken,
        env.GOOGLE_DRIVE_FOLDER_ID,
        pendingName,
      );
      if (!found) {
        return jsonError(
          "Could not find uploaded file in Drive by pending name. The upload may have failed before any bytes were written.",
          404,
        );
      }
      driveFileId = found.id;
    }

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
        description: metadata.description ? String(metadata.description).trim() : "",
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

    // Best-effort: append a row to the submissions sheet if GOOGLE_SHEET_ID
    // is configured. Failure here does NOT fail the submission — the video
    // and metadata.json are the authoritative record.
    let sheetStatus: "skipped" | "ok" | string = "skipped";
    if (env.GOOGLE_SHEET_ID) {
      try {
        const specs = metadata.specs ?? {};
        const submittedAtPT = new Date(submittedAt).toLocaleString("en-US", {
          timeZone: "America/Los_Angeles",
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        });
        const fpsStr =
          typeof specs.fps === "number" ? specs.fps.toFixed(2) + "p" : "";
        const durStr =
          typeof specs.duration === "number"
            ? Math.floor(specs.duration / 60) +
              ":" +
              String(Math.floor(specs.duration % 60)).padStart(2, "0")
            : "";
        const resStr =
          specs.width && specs.height ? `${specs.width}×${specs.height}` : "";
        const sizeStr =
          typeof specs.size === "number"
            ? specs.size > 1024 * 1024 * 1024
              ? (specs.size / 1024 ** 3).toFixed(2) + " GB"
              : Math.round(specs.size / 1024 ** 2) + " MB"
            : "";

        // Row order MUST match SUBMISSION_SHEET_HEADERS in _shared/google.ts
        const row: (string | number | null)[] = [
          submittedAtPT + " PT", // Submitted At (PT)
          "✓ Success", // Success
          submissionId, // Submission ID
          String(metadata.teamId).trim(), // Team ID
          String(metadata.discord).trim(), // Team Lead Discord
          String(metadata.email).trim(), // Team Lead Email
          String(metadata.title).trim(), // Film Title
          metadata.description ? String(metadata.description).trim() : "", // Description
          String(metadata.tool).trim(), // Primary Tool
          renamed.name ?? "", // Drive File Name
          renamed.webViewLink ?? "", // Drive View Link
          resStr, // Resolution
          fpsStr, // Frame Rate
          durStr, // Duration
          sizeStr, // File Size
          request.headers.get("cf-connecting-ip") ?? "", // Client IP
          (request.headers.get("user-agent") ?? "").slice(0, 200), // User Agent (truncated)
        ];

        await appendSubmissionRow(accessToken, env.GOOGLE_SHEET_ID, row);
        sheetStatus = "ok";
      } catch (sheetErr) {
        console.error("[finalize] Sheet append failed:", sheetErr);
        sheetStatus =
          sheetErr instanceof Error ? sheetErr.message : String(sheetErr);
      }
    }

    return json({
      ok: true,
      submissionId,
      submittedAt,
      driveFileId,
      driveFileName: renamed.name,
      metadataFileId: metadataFile.id,
      viewUrl: renamed.webViewLink ?? null,
      sheetStatus,
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
