// Shared Google OAuth + Drive API helpers for Soulscape submission portal.
//
// All requests use OAuth 2.0 with a long-lived refresh token — we exchange
// the refresh token for a short-lived access token on every request. This
// keeps us stateless (no KV cache) and eliminates any risk of a stale token
// lingering if we ever rotate credentials. Token refresh adds ~150ms of
// latency but is trivial compared to file upload time.

export interface GoogleEnv {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;
  GOOGLE_DRIVE_FOLDER_ID: string;
  /** Optional — if set, finalize appends a submission row to this sheet */
  GOOGLE_SHEET_ID?: string;
}

/** Column headers for the submissions sheet. Used both for initial row
 *  seeding and to make the append order explicit. Order must stay in
 *  sync with the values built in finalize.ts. */
export const SUBMISSION_SHEET_HEADERS = [
  "Submitted At (PT)",
  "Success",
  "Submission ID",
  "Team ID",
  "Team Lead Discord",
  "Team Lead Email",
  "Film Title",
  "Description",
  "Primary Tool",
  "Drive File Name",
  "Drive View Link",
  "Resolution",
  "Frame Rate",
  "Duration",
  "File Size",
  "Client IP",
  "User Agent",
] as const;

export class GoogleApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
  }
}

/**
 * Exchange the long-lived refresh token for a short-lived access token
 * via Google's OAuth 2.0 token endpoint.
 */
export async function getAccessToken(env: GoogleEnv): Promise<string> {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.GOOGLE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new GoogleApiError(
      `OAuth refresh failed (${res.status}) — check GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN env vars`,
      res.status,
      body,
    );
  }

  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new GoogleApiError(
      "OAuth refresh returned no access_token",
      500,
      JSON.stringify(data),
    );
  }
  return data.access_token;
}

/**
 * Start a resumable upload session for a file in the target Drive folder.
 * Returns the upload session URL — the browser PUTs the file bytes directly
 * to this URL. It is self-authenticating (does NOT require the access token),
 * and valid for about 1 week.
 */
export async function initiateResumableUpload(
  accessToken: string,
  folderId: string,
  metadata: {
    name: string;
    mimeType: string;
    description?: string;
    properties?: Record<string, string>;
  },
  fileSize: number,
): Promise<string> {
  const url =
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "content-type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": metadata.mimeType,
      "X-Upload-Content-Length": String(fileSize),
    },
    body: JSON.stringify({
      ...metadata,
      parents: [folderId],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new GoogleApiError(
      `Drive resumable init failed (${res.status}) — check GOOGLE_DRIVE_FOLDER_ID and that the OAuth account has write access`,
      res.status,
      body,
    );
  }

  const location = res.headers.get("Location");
  if (!location) {
    throw new GoogleApiError(
      "Drive resumable init returned no Location header",
      500,
      "",
    );
  }
  return location;
}

/**
 * GET file metadata (name, size, mimeType, parents, createdTime, md5Checksum).
 * Used by /api/finalize to verify the upload completed successfully.
 */
export async function getFileMetadata(
  accessToken: string,
  fileId: string,
  fields = "id,name,mimeType,size,parents,createdTime,md5Checksum,webViewLink",
): Promise<DriveFileMetadata> {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=${encodeURIComponent(fields)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new GoogleApiError(
      `Drive files.get failed (${res.status}) for file ${fileId}`,
      res.status,
      body,
    );
  }
  return (await res.json()) as DriveFileMetadata;
}

/**
 * Look up a Drive file by exact name within a parent folder.
 * Used as a fallback when the browser's upload XHR errors at 100 % (CORS
 * on Google's final response): even though the browser can't read the
 * response body, the file actually exists in Drive and we can find it by
 * the pending name we assigned during initiate.
 */
export async function findFileByName(
  accessToken: string,
  folderId: string,
  name: string,
): Promise<DriveFileMetadata | null> {
  // Escape single quotes per Drive query syntax
  const escapedName = name.replace(/'/g, "\\'");
  const q = encodeURIComponent(
    `'${folderId}' in parents and name = '${escapedName}' and trashed = false`,
  );
  const fields = encodeURIComponent(
    "files(id,name,mimeType,size,parents,createdTime,md5Checksum,webViewLink)",
  );
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=5&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=${fields}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new GoogleApiError(
      `Drive files.list (lookup by name) failed (${res.status})`,
      res.status,
      body,
    );
  }
  const data = (await res.json()) as { files?: DriveFileMetadata[] };
  if (!data.files || data.files.length === 0) return null;
  // If there are multiple matches (shouldn't happen with our naming scheme),
  // return the most recent by createdTime
  return data.files.sort((a, b) =>
    String(b.createdTime ?? "").localeCompare(String(a.createdTime ?? "")),
  )[0];
}

/**
 * Rename a Drive file (changes its `name` field, keeps ID/content/parents).
 */
export async function renameFile(
  accessToken: string,
  fileId: string,
  newName: string,
): Promise<DriveFileMetadata> {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id,name,webViewLink`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: newName }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new GoogleApiError(
      `Drive files.update (rename) failed (${res.status})`,
      res.status,
      body,
    );
  }
  return (await res.json()) as DriveFileMetadata;
}

/**
 * Create a small file (e.g. metadata.json) via multipart upload.
 * Good for files under a few MB; we use it for JSON blobs under 1KB.
 */
export async function createJsonFile(
  accessToken: string,
  folderId: string,
  name: string,
  jsonContent: unknown,
): Promise<DriveFileMetadata> {
  const boundary = "soulscape_" + crypto.randomUUID();
  const metadata = {
    name,
    mimeType: "application/json",
    parents: [folderId],
  };
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${JSON.stringify(jsonContent, null, 2)}\r\n` +
    `--${boundary}--`;

  const url =
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "content-type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new GoogleApiError(
      `Drive files.create (metadata JSON) failed (${res.status})`,
      res.status,
      errBody,
    );
  }
  return (await res.json()) as DriveFileMetadata;
}

/**
 * List JSON files (metadata manifests) in the target folder, newest first.
 * Each entry contains the file ID and name, so the caller can then fetch
 * each file's contents individually.
 */
export async function listMetadataFiles(
  accessToken: string,
  folderId: string,
): Promise<DriveFileMetadata[]> {
  const q = encodeURIComponent(
    `'${folderId}' in parents and name contains '_metadata.json' and trashed = false`,
  );
  const fields = encodeURIComponent("files(id,name,size,createdTime,webViewLink)");
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=createdTime desc&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=${fields}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new GoogleApiError(
      `Drive files.list failed (${res.status})`,
      res.status,
      body,
    );
  }
  const data = (await res.json()) as { files?: DriveFileMetadata[] };
  return data.files ?? [];
}

/**
 * Append a single row to a Google Sheet via the Sheets API. If the sheet
 * appears empty (no data in A1), we first write the SUBMISSION_SHEET_HEADERS
 * row, then append the data row. The Drive scope is sufficient for the
 * Sheets API, so no separate OAuth scope is required.
 *
 * This is best-effort: if writing to the sheet fails, the caller should log
 * the error but NOT reject the submission, since the authoritative record is
 * the metadata.json sidecar we write in the Drive folder.
 */
export async function appendSubmissionRow(
  accessToken: string,
  sheetId: string,
  row: (string | number | null | undefined)[],
): Promise<void> {
  // Step 1: read A1 to see if headers exist
  const a1Url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/A1?majorDimension=ROWS`;
  let needsHeaders = false;
  const a1Res = await fetch(a1Url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (a1Res.ok) {
    const a1Data = (await a1Res.json()) as { values?: string[][] };
    needsHeaders = !a1Data.values || a1Data.values.length === 0;
  } else if (a1Res.status === 404) {
    throw new GoogleApiError(
      `Sheet ${sheetId} not found — check GOOGLE_SHEET_ID env var`,
      404,
      await a1Res.text(),
    );
  } else {
    // 403, etc — probably scope issue
    throw new GoogleApiError(
      `Sheets API read failed (${a1Res.status}) — make sure the Sheets API is enabled in Google Cloud Console`,
      a1Res.status,
      await a1Res.text(),
    );
  }

  // Step 2: if empty, write the header row first via values.update (not append)
  // so it lands in row 1 deterministically
  if (needsHeaders) {
    const headerUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/A1?valueInputOption=RAW`;
    const headerRes = await fetch(headerUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        range: "A1",
        majorDimension: "ROWS",
        values: [SUBMISSION_SHEET_HEADERS.slice()],
      }),
    });
    if (!headerRes.ok) {
      throw new GoogleApiError(
        `Sheets API header write failed (${headerRes.status})`,
        headerRes.status,
        await headerRes.text(),
      );
    }
  }

  // Step 3: append the data row (Sheets auto-picks the first empty row)
  const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/A:A:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const appendRes = await fetch(appendUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      majorDimension: "ROWS",
      values: [row.map((v) => (v == null ? "" : String(v)))],
    }),
  });
  if (!appendRes.ok) {
    throw new GoogleApiError(
      `Sheets API append failed (${appendRes.status})`,
      appendRes.status,
      await appendRes.text(),
    );
  }
}

/**
 * Download a Drive file's content as JSON. Used by admin/list to read each
 * metadata manifest and aggregate into a table.
 */
export async function readFileAsJson<T = unknown>(
  accessToken: string,
  fileId: string,
): Promise<T> {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new GoogleApiError(
      `Drive files.get?alt=media failed (${res.status})`,
      res.status,
      body,
    );
  }
  return (await res.json()) as T;
}

/**
 * Build a short random submission ID in the form SSF26-XXXX-YYYY.
 */
export function generateSubmissionId(): string {
  const t = Date.now().toString(36).toUpperCase();
  const randBytes = crypto.getRandomValues(new Uint8Array(4));
  const rand = Array.from(randBytes)
    .map((b) => b.toString(36).toUpperCase())
    .join("")
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 4)
    .padEnd(4, "X");
  return `SSF26-${t}-${rand}`;
}

/**
 * Sanitize a string for safe use in a Drive file name.
 * Replaces path separators and control chars with underscores, collapses
 * whitespace, and truncates to 120 chars.
 */
export function safeFilePart(input: string, maxLen = 120): string {
  return (
    input
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f\\/]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLen) || "untitled"
  );
}

export interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
  parents?: string[];
  createdTime?: string;
  md5Checksum?: string;
  webViewLink?: string;
}
