import type { Db } from "./db";

export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  // Overridable so tests can point at a fake Google server.
  authUrl: string; // https://accounts.google.com/o/oauth2/v2/auth
  tokenUrl: string; // https://oauth2.googleapis.com/token
  apiBase: string; // https://www.googleapis.com
};

export const SCOPES = "openid email https://www.googleapis.com/auth/drive.file";
const FILE_FIELDS = "id,name,mimeType,size,parents,trashed,webViewLink,webContentLink,thumbnailLink";

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  parents?: string[];
  trashed?: boolean;
  webViewLink?: string;
  webContentLink?: string;
  thumbnailLink?: string;
};

export class GoogleError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function check(res: Response, what: string): Promise<Response> {
  if (!res.ok) throw new GoogleError(`${what} 실패 (${res.status}): ${(await res.text()).slice(0, 300)}`, res.status);
  return res;
}

export function createGoogle(cfg: GoogleConfig, db: Db) {
  let accessToken: { token: string; expiresAt: number } | null = null;

  function authRedirect(state: string, forceConsent: boolean): string {
    const u = new URL(cfg.authUrl);
    u.search = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      response_type: "code",
      scope: SCOPES,
      access_type: "offline",
      include_granted_scopes: "true",
      state,
      ...(forceConsent ? { prompt: "consent" } : {}),
    }).toString();
    return u.toString();
  }

  async function tokenRequest(params: Record<string, string>) {
    const res = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...params }),
    });
    await check(res, "구글 토큰 요청");
    return (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string; id_token?: string };
  }

  // Exchanges the login code. The id_token comes straight from Google's token endpoint over TLS,
  // so its payload can be read without verifying the signature.
  // The caller stores the tokens only after it has accepted the email.
  async function exchangeCode(code: string) {
    const tokens = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: cfg.redirectUri });
    if (!tokens.id_token) throw new GoogleError("id_token 없음", 502);
    const payload = JSON.parse(Buffer.from(tokens.id_token.split(".")[1]!, "base64url").toString("utf8"));
    return {
      email: String(payload.email ?? "").toLowerCase(),
      emailVerified: payload.email_verified === true || payload.email_verified === "true",
      tokens,
    };
  }

  function saveTokens(t: { access_token: string; expires_in: number; refresh_token?: string }) {
    if (t.refresh_token) db.setSetting("refresh_token", t.refresh_token);
    accessToken = { token: t.access_token, expiresAt: Date.now() + (t.expires_in - 60) * 1000 };
  }

  async function token(): Promise<string> {
    if (accessToken && accessToken.expiresAt > Date.now()) return accessToken.token;
    const refresh = db.getSetting("refresh_token");
    if (!refresh) throw new GoogleError("구글 드라이브가 연결되지 않았습니다. 다시 로그인해 주세요.", 401);
    const t = await tokenRequest({ refresh_token: refresh, grant_type: "refresh_token" });
    saveTokens(t);
    return t.access_token;
  }

  async function api(path: string, init: RequestInit = {}, what = "드라이브 요청"): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await token()}`);
    return check(await fetch(cfg.apiBase + path, { ...init, headers }), what);
  }

  // Shared while in flight so concurrent first uploads don't each create a folder.
  let creatingRoot: Promise<string> | null = null;

  function rootFolder(): Promise<string> {
    const existing = db.getSetting("root_folder_id");
    if (existing) return Promise.resolve(existing);
    creatingRoot ??= (async () => {
      const res = await api(
        "/drive/v3/files?fields=id",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "kacarong.kr 파일함", mimeType: "application/vnd.google-apps.folder" }),
        },
        "드라이브 폴더 생성",
      );
      const { id } = (await res.json()) as { id: string };
      db.setSetting("root_folder_id", id);
      return id;
    })().finally(() => (creatingRoot = null));
    return creatingRoot;
  }

  async function getFile(id: string): Promise<DriveFile> {
    const res = await api(`/drive/v3/files/${encodeURIComponent(id)}?fields=${FILE_FIELDS}`, {}, "파일 조회");
    return (await res.json()) as DriveFile;
  }

  return {
    authRedirect,
    exchangeCode,
    saveTokens,
    rootFolder,
    getFile,

    // Starts a resumable upload session; the browser then PUTs the bytes straight to Google.
    // Passing Origin here is what makes Google answer the browser's CORS requests on the session URI.
    async startUpload(meta: { name: string; mimeType: string; size: number; origin: string }): Promise<string> {
      const parent = await rootFolder();
      const res = await api(
        `/upload/drive/v3/files?uploadType=resumable&fields=${FILE_FIELDS}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Type": meta.mimeType || "application/octet-stream",
            "X-Upload-Content-Length": String(meta.size),
            Origin: meta.origin,
          },
          body: JSON.stringify({ name: meta.name, parents: [parent] }),
        },
        "업로드 시작",
      );
      const location = res.headers.get("Location");
      if (!location) throw new GoogleError("업로드 주소를 받지 못했습니다", 502);
      return location;
    },

    // Asks Google how many bytes a resumable session already has. Used when the browser
    // cannot read the Range header of a 308 reply. Only real Drive upload session URLs are accepted.
    async uploadStatus(sessionUrl: string, size: number): Promise<{ next: number } | { file: DriveFile }> {
      const u = URL.canParse(sessionUrl) ? new URL(sessionUrl) : null;
      if (!u || `${u.origin}${u.pathname}` !== `${cfg.apiBase}/upload/drive/v3/files` || !u.searchParams.get("upload_id")) {
        throw new GoogleError("업로드 주소가 올바르지 않습니다", 400);
      }
      const res = await fetch(u, { method: "PUT", headers: { "Content-Range": `bytes */${size}` } });
      if (res.status === 200 || res.status === 201) return { file: (await res.json()) as DriveFile };
      if (res.status !== 308) throw new GoogleError(`업로드 상태 조회 실패 (${res.status})`, res.status);
      const range = res.headers.get("Range"); // absent when nothing has been received yet
      return { next: range ? Number(range.split("-")[1]) + 1 : 0 };
    },

    async share(id: string) {
      await api(
        `/drive/v3/files/${encodeURIComponent(id)}/permissions?fields=id`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "anyone", role: "reader" }) },
        "공유 켜기",
      );
    },

    async unshare(id: string) {
      try {
        await api(`/drive/v3/files/${encodeURIComponent(id)}/permissions/anyoneWithLink`, { method: "DELETE" }, "공유 끄기");
      } catch (e) {
        if (!(e instanceof GoogleError && e.status === 404)) throw e; // already private
      }
    },

    async trash(id: string) {
      await api(
        `/drive/v3/files/${encodeURIComponent(id)}`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) },
        "휴지통으로 이동",
      );
    },

    async quota(): Promise<{ limit?: string; usage?: string; usageInDrive?: string; usageInDriveTrash?: string }> {
      const res = await api("/drive/v3/about?fields=storageQuota", {}, "용량 조회");
      return ((await res.json()) as { storageQuota: Record<string, string> }).storageQuota;
    },

    // thumbnailLink is short-lived, so fetch it fresh and let the caller cache the bytes.
    async thumbnail(id: string): Promise<{ bytes: ArrayBuffer; type: string } | null> {
      const f = await getFile(id);
      if (!f.thumbnailLink) return null;
      const res = await fetch(f.thumbnailLink, { headers: { Authorization: `Bearer ${await token()}` } });
      if (!res.ok) return null;
      return { bytes: await res.arrayBuffer(), type: res.headers.get("Content-Type") ?? "image/jpeg" };
    },
  };
}

export type Google = ReturnType<typeof createGoogle>;
