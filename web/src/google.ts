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

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
// Making, changing and deleting events (calendar.readonly is still needed for the calendar list).
export const CALENDAR_WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events";
export const SCOPES = `openid email https://www.googleapis.com/auth/drive.file ${CALENDAR_SCOPE} ${CALENDAR_WRITE_SCOPE}`;
// Just who is signing in. Asking for the calendar scope again on every sign-in makes Google show
// its "unverified app" warning every time, even when the grant already exists.
const LOGIN_SCOPES = "openid email";
const FILE_FIELDS = "id,name,mimeType,size,parents,trashed,thumbnailLink";

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  parents?: string[];
  trashed?: boolean;
  thumbnailLink?: string;
};

// One event from the user's Google Calendar, tagged with the calendar it came from.
// editable: the calendar lets the user change events (owner or writer).
// pushed: the event is a task or exam this site put there (extendedProperties.private.kacarong).
export type CalendarEvent = {
  id: string;
  summary?: string;
  htmlLink?: string;
  location?: string;
  description?: string;
  start: { date?: string; dateTime?: string };
  end: { date?: string; dateTime?: string };
  calendar: string;
  calendarId: string;
  color: string;
  editable: boolean;
  pushed: boolean;
};
export type CalendarInfo = { id: string; summary?: string; backgroundColor?: string; selected?: boolean; primary?: boolean; accessRole?: string };
// What this site sends for an event. start/end carry nulls for the unused keys so a PATCH can switch all-day ↔ timed.
export type EventBody = {
  summary: string;
  location?: string;
  description?: string;
  start: { date: string | null; dateTime: string | null; timeZone: string | null };
  end: { date: string | null; dateTime: string | null; timeZone: string | null };
  extendedProperties?: { private: Record<string, string> };
};
const withoutNulls = (b: EventBody) => JSON.stringify(b, (_k, v) => (v === null ? undefined : v));

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

  // loginHint makes Google pick that account by itself, so a returning owner signs in without a click.
  // needGrant asks for every scope with a fresh consent, so Google issues a new refresh token.
  function authRedirect(state: string, needGrant: boolean, loginHint: string): string {
    const u = new URL(cfg.authUrl);
    u.search = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      response_type: "code",
      state,
      ...(loginHint ? { login_hint: loginHint } : {}),
      // A plain sign-in must not pull the saved calendar grant back in (include_granted_scopes),
      // or Google treats it as a sensitive request again. Its token is thrown away anyway.
      ...(needGrant
        ? { scope: SCOPES, access_type: "offline", include_granted_scopes: "true", prompt: "consent" }
        : { scope: LOGIN_SCOPES, access_type: "online" }),
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
    return (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string; id_token?: string; scope?: string };
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

  function saveTokens(t: { access_token: string; expires_in: number; refresh_token?: string; scope?: string }) {
    if (t.refresh_token) db.setSetting("refresh_token", t.refresh_token);
    if (t.scope) db.setSetting("granted_scopes", t.scope); // the user may untick some scopes on the consent screen
    accessToken = { token: t.access_token, expiresAt: Date.now() + (t.expires_in - 60) * 1000 };
  }

  async function token(): Promise<string> {
    if (accessToken && accessToken.expiresAt > Date.now()) return accessToken.token;
    const refresh = db.getSetting("refresh_token");
    if (!refresh) throw new GoogleError("구글 드라이브가 연결되지 않았습니다. 다시 로그인해 주세요.", 401);
    let t;
    try {
      t = await tokenRequest({ refresh_token: refresh, grant_type: "refresh_token" });
    } catch (e) {
      // Revoked or expired grant: plain sign-ins don't renew it, so make the next sign-in ask for the full grant.
      if (e instanceof GoogleError && e.message.includes("invalid_grant")) db.setSetting("granted_scopes", "");
      throw e;
    }
    saveTokens(t);
    return t.access_token;
  }

  async function api(path: string, init: RequestInit = {}, what = "드라이브 요청"): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await token()}`);
    return check(await fetch(cfg.apiBase + path, { ...init, headers }), what);
  }

  async function createFolder(name: string, parent?: string): Promise<string> {
    const res = await api(
      "/drive/v3/files?fields=id",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", ...(parent ? { parents: [parent] } : {}) }),
      },
      "드라이브 폴더 생성",
    );
    return ((await res.json()) as { id: string }).id;
  }

  // A top-level Drive folder made once and remembered in settings[key].
  // Shared while in flight so concurrent first uploads don't each create a folder.
  const creating = new Map<string, Promise<string>>();
  function ownFolder(key: string, name: string): Promise<string> {
    const existing = db.getSetting(key);
    if (existing) return Promise.resolve(existing);
    if (!creating.has(key)) {
      creating.set(
        key,
        (async () => {
          const id = await createFolder(name);
          db.setSetting(key, id);
          return id;
        })().finally(() => creating.delete(key)),
      );
    }
    return creating.get(key)!;
  }
  // The cloud's files, laid out like the cloud.
  const rootFolder = () => ownFolder("root_folder_id", "kacarong.kr 파일함");
  // Copies of files in Notion pages, kept apart so the cloud's folder holds only what was uploaded to the cloud.
  const notionFolder = () => ownFolder("notion_folder_id", "kacarong.kr 노션 파일");

  async function getFile(id: string): Promise<DriveFile> {
    const res = await api(`/drive/v3/files/${encodeURIComponent(id)}?fields=${FILE_FIELDS}`, {}, "파일 조회");
    return (await res.json()) as DriveFile;
  }

  // Tokens saved before the calendar scope was added have no granted_scopes, so they count as not granted.
  const granted = (scope: string) => (db.getSetting("granted_scopes") ?? "").split(" ").includes(scope);
  const calendarGranted = () => granted(CALENDAR_SCOPE);
  const calendarWriteGranted = () => granted(CALENDAR_WRITE_SCOPE);

  async function calendarList(): Promise<CalendarInfo[]> {
    const res = await api("/calendar/v3/users/me/calendarList?fields=items(id,summary,backgroundColor,selected,primary,accessRole)", {}, "캘린더 목록 조회");
    return ((await res.json()) as { items?: CalendarInfo[] }).items ?? [];
  }
  const eventPath = (calendarId: string, eventId = "") => `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events${eventId ? "/" + encodeURIComponent(eventId) : ""}`;

  return {
    apiOrigin: new URL(cfg.apiBase).origin, // where the browser sends upload bytes
    authRedirect,
    exchangeCode,
    saveTokens,
    rootFolder,
    notionFolder,
    createFolder,
    getFile,
    calendarGranted,
    calendarWriteGranted,
    calendarList,

    // Keeps the Drive copy laid out like the cloud: a rename or a move here is made there too.
    async rename(id: string, name: string) {
      await api(`/drive/v3/files/${encodeURIComponent(id)}?fields=id`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }, "드라이브 이름 바꾸기");
    },
    async move(id: string, from: string, to: string) {
      if (from === to) return;
      const q = new URLSearchParams({ addParents: to, removeParents: from, fields: "id" });
      await api(`/drive/v3/files/${encodeURIComponent(id)}?${q}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}" }, "드라이브에서 옮기기");
    },

    // The file's bytes, streamed. range is the browser's Range header, passed on so videos can seek.
    async download(id: string, range: string | null): Promise<Response> {
      const headers = new Headers({ Authorization: `Bearer ${await token()}` });
      if (range) headers.set("Range", range);
      const res = await fetch(`${cfg.apiBase}/drive/v3/files/${encodeURIComponent(id)}?alt=media`, { headers });
      if (res.status === 416) return res; // a range past the end: the caller passes it on as is
      return check(res, "파일 받기");
    },

    // Events between two instants from every calendar the user has checked in Google Calendar.
    // cals: the calendar list when the caller already has it.
    async events(timeMin: string, timeMax: string, cals?: CalendarInfo[]): Promise<CalendarEvent[]> {
      const shown = (cals ?? (await calendarList())).filter((c) => c.selected || c.primary);
      const q = new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "2500", timeZone: "Asia/Seoul" });
      type Item = Pick<CalendarEvent, "id" | "summary" | "htmlLink" | "location" | "description" | "start" | "end"> & { status?: string; extendedProperties?: { private?: Record<string, string> } };
      const lists = await Promise.all(
        shown.map(async (c) => {
          const r = await api(`${eventPath(c.id)}?${q}`, {}, "캘린더 일정 조회");
          const items = ((await r.json()) as { items?: Item[] }).items ?? [];
          const editable = c.accessRole === "owner" || c.accessRole === "writer";
          return items
            .filter((e) => e.status !== "cancelled" && e.start && e.end)
            .map((e) => ({
              id: e.id,
              summary: e.summary,
              htmlLink: e.htmlLink,
              location: e.location,
              description: e.description,
              start: e.start,
              end: e.end,
              calendar: c.summary ?? "",
              calendarId: c.id,
              color: c.backgroundColor ?? "",
              editable,
              pushed: !!e.extendedProperties?.private?.kacarong,
            }));
        }),
      );
      return lists.flat();
    },

    async insertEvent(calendarId: string, body: EventBody): Promise<string> {
      const res = await api(`${eventPath(calendarId)}?fields=id`, { method: "POST", headers: { "Content-Type": "application/json" }, body: withoutNulls(body) }, "구글 일정 만들기");
      return ((await res.json()) as { id: string }).id;
    },
    async patchEvent(calendarId: string, eventId: string, body: EventBody) {
      await api(`${eventPath(calendarId, eventId)}?fields=id`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, "구글 일정 고치기");
    },
    async deleteEvent(calendarId: string, eventId: string) {
      await api(eventPath(calendarId, eventId), { method: "DELETE" }, "구글 일정 지우기");
    },

    // Starts a resumable upload session; the browser then PUTs the bytes straight to Google.
    // Passing Origin here is what makes Google answer the browser's CORS requests on the session URI.
    // parent: the Drive folder to put it in (the cloud folder's copy); the top folder when not given.
    async startUpload(meta: { name: string; mimeType: string; size: number; origin: string; parent?: string }): Promise<string> {
      const parent = meta.parent ?? (await rootFolder());
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

    // Uploads bytes the server already holds (Notion files) in one PUT to a resumable session.
    async upload(name: string, mimeType: string, bytes: Blob, origin: string, parent?: string): Promise<DriveFile> {
      const location = await this.startUpload({ name, mimeType, size: bytes.size, origin, parent });
      const res = await check(await fetch(location, { method: "PUT", headers: { "Content-Type": mimeType }, body: bytes }), "업로드");
      return (await res.json()) as DriveFile;
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
