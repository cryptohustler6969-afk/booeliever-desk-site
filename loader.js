/* Unlock + decrypt loader. Everything sensitive (the app and its data) is AES-256-GCM ciphertext;
   the key is derived from the password with PBKDF2-SHA256 (iterations + salt in kdf.json). */
"use strict";
(() => {
const KEY_LS = "bd_key_v2", STORE_PREFIX = "bd_enc_";
["bd_live_points_v1", "bd_last_prices_v1"].forEach((k) => localStorage.removeItem(k)); // old plaintext keys
const te = new TextEncoder(), td = new TextDecoder();
const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64e = (u) => { let s = ""; const a = new Uint8Array(u); for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); };
const $ = (id) => document.getElementById(id);

let installEvt = null;
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; dispatchEvent(new Event("bd-installable")); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

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

async function start(raw, remember, kdf) {
  const key = await aesKey(raw);
  const app = await fetchEnc(key, "app.enc"); // throws OperationError on a wrong key
  if (remember) localStorage.setItem(KEY_LS, JSON.stringify({ salt: kdf.salt, key: b64e(raw) }));
  window.BD = {
    loadData: () => fetchEnc(key, "data.enc"),
    get: async (name) => { try { const v = localStorage.getItem(STORE_PREFIX + name); return v ? JSON.parse(await decryptEnv(key, JSON.parse(v))) : null; } catch (e) { return null; } },
    set: async (name, obj) => { try { localStorage.setItem(STORE_PREFIX + name, await encryptStr(key, JSON.stringify(obj))); } catch (e) { /* storage full */ } },
    lock: () => { localStorage.removeItem(KEY_LS); Object.keys(localStorage).filter((k) => k.startsWith(STORE_PREFIX)).forEach((k) => localStorage.removeItem(k)); location.reload(); },
    installPrompt: () => installEvt,
  };
  const style = document.createElement("style"); style.textContent = app.css; document.head.appendChild(style);
  document.querySelectorAll("head > style:not(:last-of-type)").forEach((s) => s.remove());
  document.title = "Booeliever Desk";
  document.body.innerHTML = app.html;
  const url = URL.createObjectURL(new Blob([app.js], { type: "text/javascript" }));
  const sc = document.createElement("script"); sc.src = url; sc.onload = () => URL.revokeObjectURL(url); document.body.appendChild(sc);
}

async function init() {
  let kdf;
  try { kdf = await getKdf(); } catch (e) { $("err").textContent = "Can't reach the server. Check your connection."; return; }
  const saved = JSON.parse(localStorage.getItem(KEY_LS) || "null");
  if (saved && saved.salt === kdf.salt) {
    try { await start(b64d(saved.key), false, kdf); return; } catch (e) { localStorage.removeItem(KEY_LS); }
  } else if (saved) localStorage.removeItem(KEY_LS);
  $("lock-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = $("pw").value, btn = $("unlock"); if (!pw) return;
    btn.disabled = true; btn.textContent = "Unlocking…"; $("err").textContent = "";
    try {
      const raw = await derive(pw, kdf);
      $("pw").value = "";
      await start(raw, $("remember").checked, kdf);
    } catch (err) {
      btn.disabled = false; btn.textContent = "Unlock";
      $("err").textContent = err && err.name === "OperationError" ? "Wrong password." : "Couldn't unlock. Check your connection and try again.";
      $("pw").select();
    }
  });
}
init();
})();
