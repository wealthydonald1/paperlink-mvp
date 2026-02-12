// src/telegram.js
export function api(token, method) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function tgRequest(token, method, body) {
  const res = await fetch(api(token, method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await res.json();
  if (!json.ok) throw new Error(`${method} failed: ${JSON.stringify(json)}`);
  return json.result;
}

// Clean messages by default (no previews)
export async function sendMessage(token, chatId, text, opts = {}) {
  return tgRequest(token, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...opts,
  });
}

export async function answerCallback(token, callbackQueryId, text = "") {
  return tgRequest(token, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text || undefined,
    show_alert: false,
  });
}

export async function editMessage(token, chatId, messageId, text, opts = {}) {
  return tgRequest(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
    ...opts,
  });
}

export function kb(rows) {
  return { reply_markup: { inline_keyboard: rows } };
}

// Forward the original message to your storage channel
export async function forwardToStorage(token, fromChatId, messageId, storageChatId) {
  return tgRequest(token, "forwardMessage", {
    chat_id: storageChatId,
    from_chat_id: fromChatId,
    message_id: messageId,
  });
}

export async function getFile(token, fileId) {
  return tgRequest(token, "getFile", { file_id: fileId });
}

// Web upload -> send document bytes to storage channel
export async function sendDocumentToStorage(token, storageChatId, buffer, filename, mimeType) {
  // Telegram sendDocument needs multipart/form-data
  const form = new FormData();
  form.append("chat_id", String(storageChatId));

  // Node supports Blob/File in newer runtimes. Use Blob.
  const blob = new Blob([buffer], { type: mimeType || "application/octet-stream" });
  form.append("document", blob, filename || "file");

  const res = await fetch(api(token, "sendDocument"), {
    method: "POST",
    body: form,
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`sendDocument failed: ${JSON.stringify(json)}`);
  return json.result;
}
