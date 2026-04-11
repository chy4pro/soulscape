// GET /api/admin/list
// Header: Authorization: Bearer <ADMIN_PASSWORD>
// Returns: { count, submissions: [...] }
//
// Lists all metadata manifests in the Drive folder (files whose name ends
// with "_metadata.json"), fetches each, and returns the aggregated array.
// Small-scale scan — fine for a few hundred entries.

import {
  GoogleApiError,
  getAccessToken,
  listMetadataFiles,
  readFileAsJson,
  type GoogleEnv,
} from "../../_shared/google";

interface Env extends GoogleEnv {
  ADMIN_PASSWORD: string;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  if (!checkAuth(request, env.ADMIN_PASSWORD)) {
    return unauthorized();
  }
  if (!env.GOOGLE_DRIVE_FOLDER_ID) {
    return json({ error: "GOOGLE_DRIVE_FOLDER_ID not set" }, 500);
  }

  try {
    const accessToken = await getAccessToken(env);
    const metadataFiles = await listMetadataFiles(
      accessToken,
      env.GOOGLE_DRIVE_FOLDER_ID,
    );

    // Fetch each metadata.json in parallel (capped concurrency would be nice
    // for thousands of entries, but for hundreds the browser / Drive API
    // can handle it)
    const submissions = await Promise.all(
      metadataFiles.map(async (f) => {
        try {
          const manifest = await readFileAsJson<Record<string, unknown>>(
            accessToken,
            f.id,
          );
          return { ...manifest, _metadataFileId: f.id };
        } catch (err) {
          return {
            submissionId: f.name?.split("_")[0] ?? "unknown",
            error: err instanceof Error ? err.message : String(err),
            _metadataFileId: f.id,
            _metadataFileName: f.name,
          };
        }
      }),
    );

    // Newest first (listMetadataFiles already sorts by createdTime desc
    // from Drive, but be defensive in case of clock skew)
    submissions.sort((a, b) => {
      const at = String(a.submittedAt ?? "");
      const bt = String(b.submittedAt ?? "");
      return bt.localeCompare(at);
    });

    return json({
      count: submissions.length,
      folderId: env.GOOGLE_DRIVE_FOLDER_ID,
      folderUrl: `https://drive.google.com/drive/folders/${env.GOOGLE_DRIVE_FOLDER_ID}`,
      submissions,
    });
  } catch (err) {
    return handleError(err);
  }
};

function checkAuth(request: Request, expected: string): boolean {
  if (!expected) return false;
  const auth = request.headers.get("Authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  return constantTimeEqual(match[1], expected);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "WWW-Authenticate": 'Bearer realm="Soulscape Admin"',
    },
  });
}

function handleError(err: unknown): Response {
  if (err instanceof GoogleApiError) {
    console.error("[admin/list] Google API error:", err.status, err.body);
    return json({ error: err.message }, err.status >= 500 ? 502 : err.status);
  }
  console.error("[admin/list] Unexpected error:", err);
  return json(
    { error: err instanceof Error ? err.message : "Internal server error" },
    500,
  );
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
