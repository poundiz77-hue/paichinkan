// ระบบออฟไลน์ของแอป "ไปจีนกัน"
// เปลี่ยนเลข VERSION เมื่อเปลี่ยนไอคอนหรือไฟล์ manifest (แก้ index.html ไม่ต้องเปลี่ยน)
const VERSION = 'v1';
const CORE = `core-${VERSION}`;
const RUNTIME = 'runtime-v1';
const CORE_FILES = ['./', 'index.html', 'config.js', 'manifest.webmanifest',
  'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CORE).then(c => c.addAll(CORE_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k.startsWith('core-') && k !== CORE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // หลังบ้าน Apps Script: ไม่เก็บแคช แอปจัดการเองอยู่แล้ว
  if (url.hostname.endsWith('google.com') || url.hostname.endsWith('googleusercontent.com')) return;

  // ฟอนต์: เก็บครั้งแรกตอนอยู่ไทย แล้วใช้จากเครื่องตลอด (Google ถูกบล็อกในจีน)
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(RUNTIME).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      try { const res = await fetch(req); c.put(req, res.clone()); return res; }
      catch (err) { return new Response('', { status: 504 }); }
    }));
    return;
  }

  // ไฟล์ของแอปเอง: ลองโหลดของใหม่ก่อน ถ้าไม่มีเน็ตใช้ของในเครื่อง
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) caches.open(CORE).then(c => c.put(req, res.clone()));
      return res;
    }).catch(async () => (await caches.match(req)) || (await caches.match('index.html'))));
  }
});
