/* Unlock + decrypt loader. Everything sensitive (the app and its data) is AES-256-GCM ciphertext;
   the key is derived from the password with PBKDF2-SHA256 (iterations + salt in kdf.json).
   The key lives only in this page's memory. It is never written to localStorage/sessionStorage,
   and the app locks itself (page reload = key and decrypted data gone) when closed, hidden or idle.
   In the Android app an optional fingerprint unlock goes through the app's origin-locked bridge. */
"use strict";
(() => {
const OLD_KEY_LS = "bd_key_v2", STORE_PREFIX = "bd_enc_";
// never keep a key between sessions: drop the old "remember on this device" key and old plaintext caches
[OLD_KEY_LS, "bd_live_points_v1", "bd_last_prices_v1"].forEach((k) => localStorage.removeItem(k));
try { sessionStorage.clear(); } catch (e) { /* ignore */ }
const T_FAST = /[?&]locktest=1\b/.test(location.search); // test mode: only ever makes timers SHORTER
const HIDDEN_GRACE_MS = T_FAST ? 2000 : 45000, IDLE_MS = T_FAST ? 6000 : 10 * 60000;
const te = new TextEncoder(), td = new TextDecoder();
const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64e = (u) => { let s = ""; const a = new Uint8Array(u); for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); };
const $ = (id) => document.getElementById(id);

let installEvt = null;
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; dispatchEvent(new Event("bd-installable")); });
const SHELL_BUILD = "1d5471b0";
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((r) => r.update()).catch(() => {});
{ const m = / BooeDesk\/([0-9A-Za-z._-]{1,12})/.exec(navigator.userAgent), v = document.getElementById("ver");
  if (v) v.textContent = (m ? "App v" + m[1] + " · " : "") + "Web " + SHELL_BUILD; }

async function getKdf() { const r = await fetch("kdf.json", { cache: "no-cache" }); if (!r.ok) throw new Error("kdf"); return r.json(); }
async function derive(pw, kdf) {
  const base = await crypto.subtle.importKey("raw", te.encode(pw), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: b64d(kdf.salt), iterations: kdf.iter }, base, 256));
}
const aesKey = (raw) => crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
async function decryptEnv(key, env) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(env.iv) }, key, b64d(env.ct));
  return td.decode(pt);
}
async function encryptStr(key, s) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return JSON.stringify({ v: 1, iv: b64e(iv), ct: b64e(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(s))) });
}
async function fetchEnc(key, path) {
  const r = await fetch(path + "?t=" + Date.now(), { cache: "no-store" });
  if (!r.ok) throw new Error("fetch " + path + " " + r.status);
  return JSON.parse(await decryptEnv(key, await r.json()));
}

// ---------- Android fingerprint bridge (absent in browsers) ----------
const bridge = () => (window.BooeBridge && typeof window.BooeBridge.postMessage === "function" ? window.BooeBridge : null);
const bio = { state: "off", handlers: [] };
function bioSend(msg) { const b = bridge(); if (b) try { b.postMessage(msg); } catch (e) { /* ignore */ } }
function bioOn(fn) { bio.handlers.push(fn); }
if (bridge()) bridge().addEventListener("message", (ev) => {
  const m = typeof ev.data === "string" ? ev.data : ""; if (!m.startsWith("bio-")) return;
  const i = m.indexOf(":"), cmd = i < 0 ? m : m.slice(0, i), arg = i < 0 ? "" : m.slice(i + 1);
  if (cmd === "bio-state") { bio.state = arg; dispatchEvent(new CustomEvent("bd-bio", { detail: arg })); }
  bio.handlers.slice().forEach((h) => h(cmd, arg));
});

// ---------- auto-lock ----------
let unlocked = false, sessionRaw = null, lastAct = Date.now(), hiddenAt = 0, hideTimer = 0;
function wipe() {
  unlocked = false; if (sessionRaw) sessionRaw.fill(0); sessionRaw = null;
  try { sessionStorage.clear(); } catch (e) { /* ignore */ }
  try { document.body.innerHTML = ""; } catch (e) { /* ignore */ }
  window.BD = null; window.BDAPP = null; window.__bd = null; window.__bdReport = null;
}
function autoLock() { if (!unlocked) return; wipe(); location.reload(); }
let wipedOnHide = false; // closing / navigating away wipes at once; a back-forward-cache restore then reloads to the lock screen
addEventListener("pagehide", () => { if (unlocked) { wipe(); wipedOnHide = true; } });
addEventListener("pageshow", (e) => { if (e.persisted && wipedOnHide) location.reload(); });
document.addEventListener("visibilitychange", () => {
  if (!unlocked) return;
  if (document.hidden) { hiddenAt = Date.now(); clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (document.hidden) autoLock(); }, HIDDEN_GRACE_MS); }
  else { clearTimeout(hideTimer); if (hiddenAt && Date.now() - hiddenAt >= HIDDEN_GRACE_MS) autoLock(); hiddenAt = 0; lastAct = Date.now(); }
});
["pointerdown", "keydown", "wheel", "touchstart", "scroll"].forEach((t) => addEventListener(t, () => { lastAct = Date.now(); }, { passive: true, capture: true }));
setInterval(() => { if (unlocked && Date.now() - lastAct >= IDLE_MS) autoLock(); }, T_FAST ? 500 : 15000);

async function start(raw, kdf, how) {
  const key = await aesKey(raw);
  const app = await fetchEnc(key, "app.enc"); // throws OperationError on a wrong key
  unlocked = true; lastAct = Date.now();
  sessionRaw = bridge() ? raw.slice() : null; // only kept (in memory) so the Android app can offer fingerprint unlock
  window.BD = {
    loadData: () => fetchEnc(key, "data.enc"),
    get: async (name) => { try { const v = localStorage.getItem(STORE_PREFIX + name); return v ? JSON.parse(await decryptEnv(key, JSON.parse(v))) : null; } catch (e) { return null; } },
    set: async (name, obj) => { try { localStorage.setItem(STORE_PREFIX + name, await encryptStr(key, JSON.stringify(obj))); } catch (e) { /* storage full */ } },
    lock: () => { Object.keys(localStorage).filter((k) => k.startsWith(STORE_PREFIX)).forEach((k) => localStorage.removeItem(k)); wipe(); location.reload(); },
    autoLock,
    installPrompt: () => installEvt,
    // fingerprint unlock (Android app only)
    bioAvailable: () => !!bridge() && bio.state !== "unavailable",
    bioEnabled: () => bio.state === "enabled",
    bioSet: (on) => { if (!bridge()) return; if (on && sessionRaw) bioSend("bio-offer:force:" + kdf.salt + ":" + b64e(sessionRaw)); else if (!on) bioSend("bio-disable"); },
  };
  const lk = document.getElementById("lock");
  if (lk && !matchMedia("(prefers-reduced-motion: reduce)").matches) { lk.classList.add("turn"); await new Promise((r) => setTimeout(r, 380)); }
  const style = document.createElement("style"); style.textContent = app.css; document.head.appendChild(style);
  document.querySelectorAll("head > style:not(:last-of-type)").forEach((s) => s.remove());
  document.title = "CryptoHustler6969 · Trading Desk";
  document.body.innerHTML = app.html;
  const url = URL.createObjectURL(new Blob([app.js], { type: "text/javascript" }));
  const sc = document.createElement("script"); sc.src = url; sc.onload = () => URL.revokeObjectURL(url); document.body.appendChild(sc);
  // after a password unlock, the Android app may ask "Unlock with fingerprint next time?"
  if (how === "password" && bridge() && sessionRaw && bio.state === "off") bioSend("bio-offer:ask:" + kdf.salt + ":" + b64e(sessionRaw));
}

async function init() {
  let kdf;
  try { kdf = await getKdf(); } catch (e) { $("err").textContent = "Can't reach the server. Check your connection."; return; }
  const btn = $("unlock"), fbtn = $("bio-btn");
  let bioTries = 0, autoPrompted = false;
  const setBusy = (b, label) => { btn.disabled = b; fbtn.disabled = b; btn.textContent = b ? label || "Unlocking…" : "Unlock"; };
  const bioPrompt = () => { if (bio.state !== "enabled" || bioTries >= 3) return; $("err").textContent = ""; bioSend("bio-unlock:" + kdf.salt); };
  const showBio = () => {
    fbtn.hidden = bio.state !== "enabled" || bioTries >= 3;
    if (!fbtn.hidden) $("lock-msg").textContent = "Private. Use your fingerprint or the password.";
    if (!fbtn.hidden && !autoPrompted && !document.hidden) { autoPrompted = true; setTimeout(bioPrompt, 250); }
  };
  addEventListener("bd-bio", showBio);
  fbtn.addEventListener("click", bioPrompt);
  bioOn(async (cmd, arg) => {
    if (unlocked) return;
    if (cmd === "bio-key") {
      setBusy(true);
      const raw = b64d(arg);
      try { await start(raw, kdf, "fingerprint"); }
      catch (err) {
        setBusy(false);
        if (err && err.name === "OperationError") { bioSend("bio-invalid"); $("err").textContent = "Fingerprint unlock was reset. Please use your password."; }
        else $("err").textContent = "Couldn't unlock. Check your connection and try again.";
      } finally { raw.fill(0); }
    } else if (cmd === "bio-fail") {
      bioTries++; $("err").textContent = (arg || "Fingerprint not recognised") + (bioTries >= 3 ? ". Please use your password." : "");
      showBio(); if (bioTries >= 3) $("pw").focus();
    } else if (cmd === "bio-cancel") { $("pw").focus(); }
  });
  bioSend("bio-hello"); // the Android app replies with bio-state:enabled|off|unavailable
  $("lock-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = $("pw").value; if (!pw) return;
    setBusy(true); $("err").textContent = "";
    let raw = null;
    try {
      raw = await derive(pw, kdf);
      $("pw").value = "";
      await start(raw, kdf, "password");
    } catch (err) {
      setBusy(false);
      $("err").textContent = err && err.name === "OperationError" ? "Wrong password." : "Couldn't unlock. Check your connection and try again.";
      $("pw").select();
    } finally { if (raw) raw.fill(0); }
  });
}
init();
})();
