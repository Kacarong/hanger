// 공개 포트폴리오: 스크롤 등장, 이미지 패럴랙스, 서울 시각.
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      io.unobserve(e.target);
    }
  },
  { threshold: 0.15, rootMargin: "0px 0px -8% 0px" },
);
document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

// 썸네일이 없으면(드라이브가 아직 못 만든 경우 등) 제목 카드로 바꾼다. CSP 때문에 인라인 onerror 대신 여기서.
const noThumb = (img) => (img.parentNode.classList.add("no-thumb"), img.remove());
document.querySelectorAll(".work-media img").forEach((img) => {
  if (img.complete && img.naturalWidth === 0) noThumb(img); // already failed before this script ran
  else img.addEventListener("error", () => noThumb(img));
});

const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const media = [...document.querySelectorAll(".work-media")];
let ticking = false;
function parallax() {
  ticking = false;
  const vh = innerHeight;
  for (const m of media) {
    const r = m.getBoundingClientRect();
    if (r.bottom < 0 || r.top > vh) continue;
    const p = (r.top + r.height / 2 - vh / 2) / vh; // -1 .. 1 around the screen center
    m.style.setProperty("--py", `${(-p * 7).toFixed(2)}%`);
  }
}
if (!reduce && media.length) {
  addEventListener("scroll", () => {
    if (!ticking) (ticking = true), requestAnimationFrame(parallax);
  }, { passive: true });
  parallax();
}

const clock = document.getElementById("clock");
const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: true });
const tick = () => (clock.textContent = fmt.format(new Date()).toUpperCase() + " KST");
tick();
setInterval(tick, 30_000);
