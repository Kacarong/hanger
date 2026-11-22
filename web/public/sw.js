// 알림만 맡는 서비스 워커: 서버가 보낸 웹 푸시를 알림으로 띄우고, 누르면 작업공간의 그 화면을 연다.
// 페이지·파일을 캐시하지 않는다(fetch 처리 없음).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let n = {};
  try {
    n = e.data ? e.data.json() : {};
  } catch {}
  e.waitUntil(
    self.registration.showNotification(n.title || "kacarong", {
      body: n.body || "",
      icon: "/static/icon-192.png",
      tag: n.id ? `n${n.id}` : undefined,
      data: { url: typeof n.url === "string" && n.url.startsWith("/") ? n.url : "/admin" },
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/admin", self.location.origin).href;
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = wins.find((w) => new URL(w.url).pathname === "/admin");
      if (open) {
        await open.focus();
        return open.navigate(url).catch(() => {});
      }
      return self.clients.openWindow(url);
    })(),
  );
});
