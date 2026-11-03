// File storage — the Cloudinary code path, end to end through the real API.
// A fake in-memory "cloud" driver stands in for Cloudinary (no network, no account needed).
// Run: npm test
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

process.env.JWT_SECRET = "test-secret-only-for-tests";
for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "SMTP_USER", "SMTP_PASS", "CLOUDINARY_URL", "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]) process.env[k] = "";
process.env.NODE_ENV = "test";

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongoose = (await import("mongoose")).default;
const mongod = await MongoMemoryServer.create();
process.env.MONGO_URI = mongod.getUri();

const { server } = await import("../src/app.js");
const User = (await import("../src/models/User.js")).default;
const storage = await import("../src/services/fileStorage.js");
const { setTranscriber } = await import("../src/services/transcriptionService.js");

/* ---------- fake cloud: Map("<folder>/<filename>") → Buffer, with Range support ---------- */
const cloud = new Map();
const calls = { upload: 0, remove: 0, move: 0, fail: false };
const fakeDriver = {
  name: "fake-cloud",
  async upload(file, folder, filename) {
    if (calls.fail) throw new Error("cloud is down");
    calls.upload += 1;
    cloud.set(`${folder}/${filename}`, fs.readFileSync(file));
  },
  async open(folder, filename, range) {
    const buf = cloud.get(`${folder}/${filename}`);
    if (!buf) return null;
    let body = buf;
    let status = 200;
    const headers = new Headers({ "content-type": "application/octet-stream", "accept-ranges": "bytes" });
    const m = /^bytes=(\d+)-(\d*)$/.exec(range || "");
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
      body = buf.subarray(start, end + 1);
      status = 206;
      headers.set("content-range", `bytes ${start}-${end}/${buf.length}`);
    }
    headers.set("content-length", String(body.length));
    return { status, headers, body: new Blob([body]).stream() };
  },
  async remove(folder, filename) {
    calls.remove += 1;
    cloud.delete(`${folder}/${filename}`);
  },
  async move(from, to, filename) {
    calls.move += 1;
    const buf = cloud.get(`${from}/${filename}`);
    if (!buf) throw new Error("not found");
    cloud.delete(`${from}/${filename}`);
    cloud.set(`${to}/${filename}`, buf);
  },
};

let base;
const T = {};
const ID = {};

const call = async (method, url, { token, json, form, headers: extra = {} } = {}) => {
  const headers = { ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form) body = form;
  const res = await fetch(base + url, { method, headers, body });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data, headers: res.headers };
};
const login = async (email) => {
  const r = await call("POST", "/api/auth/login", { json: { email, password: "Pass@123" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.data.token;
};
const onDisk = (folder, filename) => fs.existsSync(storage.localPath(folder, filename));

before(async () => {
  storage.setRemoteStorage(fakeDriver);
  await mongoose.connect(mongod.getUri());
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;

  const a = await User.create({ name: "Ada Admin", email: "ada@fs.io", password: "Pass@123", role: "Admin", companyName: "Acme" });
  const b = await User.create({ name: "Ben Admin", email: "ben@fs.io", password: "Pass@123", role: "Admin", companyName: "Beta" });
  const u = await User.create({ name: "Uma", email: "uma@fs.io", password: "Pass@123", role: "User", admin_id: a._id, department: "Dev" });
  Object.assign(ID, { a: a._id, b: b._id, u: u._id });
  T.ada = await login("ada@fs.io");
  T.ben = await login("ben@fs.io");
  T.uma = await login("uma@fs.io");
});

after(async () => {
  storage.setRemoteStorage(null);
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mongod.stop();
});

describe("Cloudinary mode (fake cloud driver)", () => {
  test("task attachments go to the cloud, not the static folder; download stays permission-checked", async () => {
    const pdf = Buffer.from("%PDF-1.4 cloud test file");
    const f = new FormData();
    f.append("name", "Cloud task");
    f.append("assignedUser", "Uma");
    f.append("dueDate", "2031-01-15");
    f.append("recurring", "false");
    f.append("files", new Blob([pdf], { type: "application/pdf" }), "spec.pdf");
    const r = await call("POST", "/api/tasks", { token: T.ada, form: f });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const file = r.data.data.attachments[0];
    ID.task = r.data.data.id;
    ID.taskFile = file.filename;

    assert.ok(cloud.has(`tasks/${file.filename}`), "stored in the cloud");
    assert.equal(onDisk("tasks", file.filename), false, "no copy left in backend/uploads/tasks");

    const dl = await call("GET", `/api/tasks/attachments/${file.filename}`, { token: T.uma });
    assert.equal(dl.status, 200);
    assert.deepEqual(dl.data, pdf, "same bytes back");
    assert.match(dl.headers.get("content-disposition") || "", /attachment; filename="spec.pdf"/);
    assert.equal((await call("GET", `/api/tasks/attachments/${file.filename}`, { token: T.ben })).status, 404, "other organization");
    assert.equal((await call("GET", `/api/tasks/attachments/${file.filename}`)).status, 401, "not logged in");
  });

  test("deleting the task deletes the cloud file", async () => {
    const before = calls.remove;
    const r = await call("DELETE", `/api/tasks/${ID.task}`, { token: T.ada });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(cloud.has(`tasks/${ID.taskFile}`), false);
    assert.ok(calls.remove > before);
  });

  test("a failed cloud upload is reported and nothing is left behind", async () => {
    calls.fail = true;
    try {
      const f = new FormData();
      f.append("name", "Will fail");
      f.append("assignedUser", "Uma");
      f.append("dueDate", "2031-01-15");
      f.append("files", new Blob(["data"], { type: "text/plain" }), "a.txt");
      const r = await call("POST", "/api/tasks", { token: T.ada, form: f });
      assert.equal(r.status, 502);
      assert.match(r.data.message, /could not be stored/);
      const left = fs.readdirSync(storage.localDir("tasks")).filter((n) => n.endsWith(".txt"));
      assert.deepEqual(left, [], "temp file removed");
    } finally {
      calls.fail = false;
    }
  });

  test("chat files: cloud upload, inline image view, member-only download", async () => {
    const conv = await call("POST", "/api/chat/private", { token: T.ada, json: { userId: String(ID.u) } });
    assert.ok([200, 201].includes(conv.status), JSON.stringify(conv.data));
    const conversationId = (conv.data.conversation || conv.data.data)._id;

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const f = new FormData();
    f.append("text", "see this");
    f.append("files", new Blob([png], { type: "image/png" }), "shot.png");
    const sent = await call("POST", `/api/chat/${conversationId}/messages`, { token: T.ada, form: f });
    assert.equal(sent.status, 201, JSON.stringify(sent.data));
    const msg = sent.data.message || sent.data.data;
    const filename = msg.attachments[0].filename;
    assert.ok(cloud.has(`chat/${filename}`));
    assert.equal(onDisk("chat", filename), false);

    const inline = await call("GET", `/api/chat/attachments/${filename}?inline=1`, { token: T.uma });
    assert.equal(inline.status, 200);
    assert.deepEqual(inline.data, png);
    assert.equal(inline.headers.get("content-type"), "image/png");
    assert.equal(inline.headers.get("content-disposition"), "inline");
    assert.equal((await call("GET", `/api/chat/attachments/${filename}`, { token: T.ben })).status, 404);
    ID.chatFile = filename;
  });

  test("expired chat message → file moved to the cloud backup folder, still downloadable", async () => {
    const { backupFilesOf } = await import("../src/services/chatBackupService.js");
    const Message = mongoose.model("Message");
    const ChatFileBackup = mongoose.model("ChatFileBackup");
    const m = await Message.findOne({ "attachments.filename": ID.chatFile }).lean();
    await backupFilesOf([m]);
    assert.ok(cloud.has(`chat-backup/${ID.chatFile}`), "moved");
    assert.equal(cloud.has(`chat/${ID.chatFile}`), false);
    const record = await ChatFileBackup.findOne({ filename: ID.chatFile }).lean();
    assert.equal(record.location, "backup");
    const dl = await call("GET", `/api/chat/backup/${record._id}/download`, { token: T.ada });
    assert.equal(dl.status, 200);
    assert.equal(dl.data.length, 7);
  });

  test("meeting attachment + recording: cloud upload, Range streaming, Whisper gets a local copy, delete cleans up", async () => {
    const m = await call("POST", "/api/meetings", {
      token: T.ada,
      json: { title: "Cloud MoM", meetingDate: "2031-09-01", meetingType: "Offline", attendees: [{ name: "Uma", email: "uma@fs.io", userId: String(ID.u) }] },
    });
    assert.equal(m.status, 201, JSON.stringify(m.data));
    const mid = m.data.data._id;

    const doc = new FormData();
    doc.append("file", new Blob(["agenda"], { type: "text/plain" }), "agenda.txt");
    const att = await call("POST", `/api/meetings/${mid}/attachments`, { token: T.ada, form: doc });
    assert.equal(att.status, 201, JSON.stringify(att.data));
    const attName = att.data.data.filename;
    assert.ok(cloud.has(`meeting-files/${attName}`));
    assert.equal(onDisk("meeting-files", attName), false);
    const got = await call("GET", `/api/meetings/attachments/${attName}`, { token: T.uma });
    assert.equal(got.status, 200);
    assert.equal(got.data.toString(), "agenda");

    const rec = new FormData();
    rec.append("recording", new Blob([Buffer.alloc(4096, 5)], { type: "video/webm" }), "meeting.webm");
    const up = await call("POST", `/api/meetings/${mid}/recording`, { token: T.ada, form: rec });
    assert.equal(up.status, 201, JSON.stringify(up.data));
    const recName = up.data.data.filename;
    assert.ok(cloud.has(`meetings/${recName}`));
    assert.equal(onDisk("meetings", recName), false);

    const part = await call("GET", `/api/meetings/${mid}/recording`, { token: T.uma, headers: { Range: "bytes=0-99" } });
    assert.equal(part.status, 206, "seeking works through the proxy");
    assert.equal(part.data.length, 100);
    assert.equal(part.headers.get("content-range"), "bytes 0-99/4096");
    assert.equal(part.headers.get("content-type"), "video/webm");
    assert.equal((await call("GET", `/api/meetings/${mid}/recording`, { token: T.ben })).status, 404);

    // transcription reads a temp local copy of the cloud recording, then removes it
    let seen = null;
    setTranscriber(async (file) => {
      seen = { file, size: fs.statSync(file).size };
      return { seconds: 1, segments: [{ text: "hello", start: 0, end: 1 }] };
    });
    // (queued directly: this build's MeetingRoutes has no /transcript/whisper route)
    const { queueTranscription } = await import("../src/services/transcriptionService.js");
    await queueTranscription(mid, ID.a);
    for (let i = 0; i < 50 && !seen; i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(seen, "transcriber ran");
    assert.equal(seen.size, 4096);
    assert.notEqual(path.dirname(seen.file), storage.localDir("meetings"), "temp file, not the uploads folder");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(fs.existsSync(seen.file), false, "temp copy removed");

    const del = await call("DELETE", `/api/meetings/${mid}`, { token: T.ada });
    assert.equal(del.status, 200, JSON.stringify(del.data));
    assert.equal(cloud.has(`meetings/${recName}`), false);
    assert.equal(cloud.has(`meeting-files/${attName}`), false);
  });

  test("files saved on disk before Cloudinary was switched on are still served", async () => {
    storage.setRemoteStorage(null);
    const f = new FormData();
    f.append("name", "Old local task");
    f.append("assignedUser", "Uma");
    f.append("dueDate", "2031-01-15");
    f.append("files", new Blob(["old file"], { type: "text/plain" }), "old.txt");
    const r = await call("POST", "/api/tasks", { token: T.ada, form: f });
    const filename = r.data.data.attachments[0].filename;
    assert.ok(onDisk("tasks", filename), "local mode keeps it on disk");

    storage.setRemoteStorage(fakeDriver); // now Cloudinary is "switched on"
    const dl = await call("GET", `/api/tasks/attachments/${filename}`, { token: T.uma });
    assert.equal(dl.status, 200);
    assert.equal(dl.data.toString(), "old file");
    await call("DELETE", `/api/tasks/${r.data.data.id}`, { token: T.ada });
    assert.equal(onDisk("tasks", filename), false);
  });
});
