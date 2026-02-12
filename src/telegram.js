const API = (token) => `https://api.telegram.org/bot${token}`;

export async function tgRequest(token, method, body) {
  const res = await fetch(`${API(token)}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method} failed: ${JSON.stringify(data)}`);
  return data.result;
}

export async function sendMessage(token, chat_id, text) {
  return tgRequest(token, "sendMessage", { chat_id, text });
}

export async function forwardToStorage(token, from_chat_id, message_id, storage_chat_id) {
  return tgRequest(token, "forwardMessage", {
    chat_id: storage_chat_id,
    from_chat_id,
    message_id,
  });
}

export async function getFile(token, file_id) {
  const res = await fetch(`${API(token)}/getFile?file_id=${encodeURIComponent(file_id)}`);
  const data = await res.json();
  if (!data.ok) throw new Error(`getFile failed: ${JSON.stringify(data)}`);
  return data.result; // { file_path, ... }
}

export async function sendDocumentToStorage(token, storage_chat_id, fileBuffer, filename, mimeType) {
  const url = `https://api.telegram.org/bot${token}/sendDocument`;

  const form = new FormData();
  form.append("chat_id", storage_chat_id);

  // Node 24 has Blob + FormData built in
  const blob = new Blob([fileBuffer], { type: mimeType || "application/octet-stream" });
  form.append("document", blob, filename);

  const res = await fetch(url, { method: "POST", body: form });
  const data = await res.json();
  if (!data.ok) throw new Error(`sendDocument failed: ${JSON.stringify(data)}`);
  return data.result; // message object
}
