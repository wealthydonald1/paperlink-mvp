import "dotenv/config";
import express from "express";
import { nanoid } from "nanoid";
import {
  insertFile,
  getFileById,
  incrementDownload,
  listFilesByOwner,
  setMaxDownloads,
  revokeFile,
} from "./db.js";
import {
  forwardToStorage,
  sendMessage,
  getFile,
  sendDocumentToStorage,
} from "./telegram.js";
import multer from "multer";

const app = express();
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB for now
});

// ngrok warning skip
app.use((req, res, next) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  next();
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // can be outdated on ngrok restart
const STORAGE_CHAT_ID = process.env.STORAGE_CHAT_ID;
const PORT = Number(process.env.PORT || 3000);

if (!BOT_TOKEN || !STORAGE_CHAT_ID) {
  console.error("Missing env vars: BOT_TOKEN, STORAGE_CHAT_ID");
}

// Use request host as fallback (helps when ngrok URL changes)
function baseUrlFromReq(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function fmtBytes(bytes) {
  const b = Number(bytes || 0);
  if (!b) return "0B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)}${units[i]}`;
}

// Telegram sometimes sends /command@BotName
function normalizeCommand(text) {
  const t = (text || "").trim();
  if (!t.startsWith("/")) return t;

  const parts = t.split(/\s+/);
  const cmd = parts[0].replace(/@[\w_]+/g, "").toLowerCase();
  return [cmd, ...parts.slice(1)].join(" ").trim();
}

function pickIncomingFile(update) {
  const msg = update.message || update.edited_message;
  if (!msg) return null;

  if (msg.document) return { file: msg.document, message: msg };
  if (msg.video) return { file: msg.video, message: msg };
  if (msg.audio) return { file: msg.audio, message: msg };

  // photos come as array sizes; pick biggest
  if (msg.photo?.length) {
    const largest = msg.photo[msg.photo.length - 1];
    return {
      file: {
        ...largest,
        file_name: `photo_${largest.file_unique_id}.jpg`,
        mime_type: "image/jpeg",
      },
      message: msg,
    };
  }

  return null;
}

async function handleCommand(message, reqBaseUrl) {
  const raw = (message.text || "").trim();
  const text = normalizeCommand(raw);

  const ownerUserId = String(message.chat.id);
  if (!ownerUserId) {
  await sendMessage(BOT_TOKEN, fromChatId, "Could not determine owner for this chat.");
  return res.status(200).send("no owner");
}

  const chatId = message.chat.id;

  console.log("CMD:", text, "chatId:", chatId, "owner:", ownerUserId);

  if (!ownerUserId) {
    await sendMessage(BOT_TOKEN, chatId, "No owner id found.");
    return true;
  }

  // /list
  if (text === "/list") {
    const rows = listFilesByOwner.all(ownerUserId, 10);

    if (!rows.length) {
      await sendMessage(
        BOT_TOKEN,
        chatId,
        "📁 No links yet.\nSend/forward a file to me and I’ll generate a link."
      );
      return true;
    }

    const lines = rows.map((r) => {
      const used = Number(r.download_count || 0);
      const max = r.max_downloads == null ? "∞" : String(r.max_downloads);
      const link = `${reqBaseUrl}/s/${r.id}`;
      return `• ${r.file_name} (${fmtBytes(r.file_size)}) — ${used}/${max}\n  ${link}`;
    });

    await sendMessage(BOT_TOKEN, chatId, `📁 Your links:\n\n${lines.join("\n\n")}`);
    return true;
  }

  // /limit <id> <n>
  if (text.startsWith("/limit")) {
    const parts = text.split(/\s+/);
    const id = parts[1];
    const n = Number(parts[2]);

    if (!id || !Number.isFinite(n) || n < 1) {
      await sendMessage(
        BOT_TOKEN,
        chatId,
        "Usage: /limit <shareId> <number>\nExample: /limit abc123 5"
      );
      return true;
    }

    const result = setMaxDownloads.run(n, id, ownerUserId);
    if (result.changes === 0) {
      await sendMessage(
        BOT_TOKEN,
        chatId,
        "Could not update. Check the shareId (or it’s not yours)."
      );
      return true;
    }

    await sendMessage(BOT_TOKEN, chatId, `✅ Set max downloads for ${id} to ${n}.`);
    return true;
  }

  // /revoke <id>
  if (text.startsWith("/revoke")) {
    const parts = text.split(/\s+/);
    const id = parts[1];

    if (!id) {
      await sendMessage(
        BOT_TOKEN,
        chatId,
        "Usage: /revoke <shareId>\nExample: /revoke abc123"
      );
      return true;
    }

    const result = revokeFile.run(id, ownerUserId);
    if (result.changes === 0) {
      await sendMessage(
        BOT_TOKEN,
        chatId,
        "Could not revoke. Check the shareId (or it’s not yours)."
      );
      return true;
    }

    await sendMessage(BOT_TOKEN, chatId, `🛑 Revoked link ${id}.`);
    return true;
  }

  // Unknown command → always reply
  if (text.startsWith("/")) {
    await sendMessage(
      BOT_TOKEN,
      chatId,
      "Commands:\n/list — show your links\n/limit <id> <n> — set max downloads\n/revoke <id> — disable a link"
    );
    return true;
  }

  return false;
}


app.post("/telegram/webhook", async (req, res) => {
  try {
    const msg = req.body.message || req.body.edited_message;

    // Handle commands first
    if (msg?.text?.startsWith("/")) {
      // safe log
      console.log("INCOMING COMMAND:", msg.text);
      const reqBaseUrl = PUBLIC_BASE_URL || baseUrlFromReq(req);
      const handled = await handleCommand(msg, reqBaseUrl);
      res.status(200).send(handled ? "ok" : "ignored");
      return;
    }

    const extracted = pickIncomingFile(req.body);

    // Not a file
    if (!extracted) {
      res.status(200).send("no file");
      return;
    }

    const { file, message } = extracted;

    const fromChatId = message.chat.id;
    const messageId = message.message_id;

    // forward original message into storage channel
    const storedMsg = await forwardToStorage(
      BOT_TOKEN,
      fromChatId,
      messageId,
      STORAGE_CHAT_ID
    );

    const shareId = nanoid(21);

    // ownership + default rules
    const ownerUserId = String(message.chat.id);
    const maxDownloads = 20; // free default
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(); // 48h

    insertFile.run({
      id: shareId,

      owner_user_id: ownerUserId,
      max_downloads: maxDownloads,
      download_count: 0,
      expires_at: expiresAt,
      is_revoked: 0,

      chat_id: String(storedMsg.chat.id),
      message_id: storedMsg.message_id,
      file_id: file.file_id,
      file_unique_id: file.file_unique_id || null,
      file_name: file.file_name || "file",
      mime_type: file.mime_type || "application/octet-stream",
      file_size: file.file_size || null,
    });

    const reqBaseUrl = PUBLIC_BASE_URL || baseUrlFromReq(req);
    const link = `${reqBaseUrl}/s/${shareId}`;
    await sendMessage(BOT_TOKEN, fromChatId, `✅ Saved!\nLink: ${link}`);

    res.status(200).send("ok");
  } catch (e) {
    console.error("Webhook error:", e);
    res.status(200).send("error");
  }
});

app.get("/", (req, res) => res.send("PaperLink MVP ✅"));

app.get("/upload", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PaperLink</title>
</head>
<body style="margin:0;background:#0b0f14;color:#e6edf3;font-family:system-ui">
  <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">
    <div style="width:100%;max-width:520px;border:1px solid #1f2a37;border-radius:16px;padding:20px;background:#0e141b">
      <div style="font-size:14px;opacity:.8;letter-spacing:.12em">PAPERLINK</div>
      <h1 style="margin:10px 0 4px;font-size:22px">Upload a file</h1>
      <div style="font-size:13px;opacity:.75;margin-bottom:16px">Select a file, then upload. You’ll get a share link.</div>

      <form action="/upload" method="post" enctype="multipart/form-data">
        <input id="file" name="file" type="file"
          style="width:100%;padding:14px;border-radius:12px;border:1px solid #1f2a37;background:#0b0f14;color:#e6edf3" />

        <div id="meta" style="margin:12px 0;font-size:13px;opacity:.8"></div>

        <button id="btn" type="submit"
          style="width:100%;padding:12px 14px;border-radius:12px;border:1px solid #2b3645;background:#111827;color:#e6edf3;font-weight:600;cursor:pointer">
          Upload
        </button>
      </form>

      <div style="margin-top:14px;font-size:12px;opacity:.6">Power-user mode. Minimal UI.</div>
    </div>
  </div>

  <script>
    const input = document.getElementById('file');
    const meta = document.getElementById('meta');
    const btn = document.getElementById('btn');

    function fmt(bytes){
      if(!bytes && bytes!==0) return '';
      const units = ['B','KB','MB','GB'];
      let i=0, v=bytes;
      while(v>=1024 && i<units.length-1){ v/=1024; i++; }
      return v.toFixed(v>=10 || i===0 ? 0 : 1) + ' ' + units[i];
    }

    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if(!f){ meta.textContent = ''; return; }
      meta.textContent = f.name + ' • ' + fmt(f.size);
      btn.textContent = 'Upload';
    });
  </script>
</body>
</html>`);
});

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send("No file uploaded");

    const storedMsg = await sendDocumentToStorage(
      BOT_TOKEN,
      STORAGE_CHAT_ID,
      req.file.buffer,
      req.file.originalname || "file",
      req.file.mimetype
    );

    const doc = storedMsg.document;

    const shareId = nanoid(21);

    // For now, web uploads have "web" owner. Later we’ll add login.
    const ownerUserId = "web";
    const maxDownloads = 20;
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

    insertFile.run({
      id: shareId,

      owner_user_id: ownerUserId,
      max_downloads: maxDownloads,
      download_count: 0,
      expires_at: expiresAt,
      is_revoked: 0,

      chat_id: String(storedMsg.chat.id),
      message_id: storedMsg.message_id,
      file_id: doc.file_id,
      file_unique_id: doc.file_unique_id || null,
      file_name: doc.file_name || req.file.originalname || "file",
      mime_type: doc.mime_type || req.file.mimetype || "application/octet-stream",
      file_size: doc.file_size || req.file.size || null,
    });

    const reqBaseUrl = PUBLIC_BASE_URL || baseUrlFromReq(req);
    const link = `${reqBaseUrl}/s/${shareId}`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"/></head>
<body style="margin:0;background:#0b0f14;color:#e6edf3;font-family:system-ui">
  <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">
    <div style="width:100%;max-width:520px;border:1px solid #1f2a37;border-radius:16px;padding:20px;background:#0e141b">
      <div style="font-size:14px;opacity:.8;letter-spacing:.12em">PAPERLINK</div>
      <h1 style="margin:10px 0 6px;font-size:22px">Uploaded</h1>
      <div style="font-size:13px;opacity:.8;margin-bottom:14px">Share link:</div>

      <input id="link" value="${link}" readonly
        style="width:100%;padding:12px;border-radius:12px;border:1px solid #1f2a37;background:#0b0f14;color:#e6edf3" />

      <button onclick="navigator.clipboard.writeText(document.getElementById('link').value)"
        style="margin-top:10px;width:100%;padding:12px 14px;border-radius:12px;border:1px solid #2b3645;background:#111827;color:#e6edf3;font-weight:600;cursor:pointer">
        Copy link
      </button>

      <a href="${link}" style="display:block;margin-top:10px;text-align:center;color:#9cc3ff;text-decoration:none">Open link</a>
      <a href="/upload" style="display:block;margin-top:12px;text-align:center;color:#9cc3ff;text-decoration:none;opacity:.8">Upload another</a>
    </div>
  </div>
</body></html>`);
  } catch (e) {
    console.error("Web upload error:", e);
    res.status(500).send("Upload failed");
  }
});

// Auto-download
app.get("/s/:id", (req, res) => {
  res.redirect(`/d/${req.params.id}`);
});

app.get("/d/:id", async (req, res) => {
  const row = getFileById.get(req.params.id);
  if (!row) return res.status(404).send("Not found");

  // revoked?
  if (Number(row.is_revoked || 0) === 1) {
    return res.status(410).send("Link revoked");
  }

  // expired?
  if (row.expires_at) {
    const exp = new Date(row.expires_at).getTime();
    if (!Number.isNaN(exp) && Date.now() > exp) {
      return res.status(410).send("Link expired");
    }
  }

  // download limit?
  const used = Number(row.download_count || 0);
  const max = row.max_downloads == null ? null : Number(row.max_downloads);
  if (max !== null && used >= max) {
    return res.status(429).send("Download limit reached");
  }

  // count this download
  console.log("DOWNLOAD HIT:", req.params.id);
  incrementDownload.run(req.params.id);

  const tgFile = await getFile(BOT_TOKEN, row.file_id);
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${tgFile.file_path}`;

  const upstream = await fetch(fileUrl);
  if (!upstream.ok) return res.status(502).send("Telegram fetch failed");

  res.setHeader("Content-Type", row.mime_type || "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${safeFilename(row.file_name || "file")}"`
  );

  upstream.body.pipeTo(
    new WritableStream({
      write(chunk) {
        return new Promise((resolve, reject) => {
          res.write(Buffer.from(chunk), (err) => (err ? reject(err) : resolve()));
        });
      },
      close() {
        res.end();
      },
    })
  );
});

app.listen(PORT, () => console.log("Server running on port", PORT));

function safeFilename(name) {
  return String(name).replace(/[/\\?%*:|"<>]/g, "_");
}
