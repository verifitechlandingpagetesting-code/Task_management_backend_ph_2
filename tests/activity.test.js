// Activity Monitoring — login sessions, presence and tenant isolation.
// Real Express app + throwaway in-memory MongoDB.   Run: npm test
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-secret-only-for-tests";
for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "SMTP_USER", "SMTP_PASS", "CLOUDINARY_URL", "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]) process.env[k] = ""; // files stay on disk in tests
process.env.NODE_ENV = "test";
process.env.ACTIVITY_DISCONNECT_GRACE_SEC = "5"; // shortest allowed, keeps the socket test quick

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongoose = (await import("mongoose")).default;
const mongod = await MongoMemoryServer.create();
process.env.MONGO_URI = mongod.getUri();

const { server } = await import("../src/app.js");
const User = (await import("../src/models/User.js")).default;
const UserActivity = (await import("../src/models/UserActivity.js")).default;
const { sweepPresence, PRESENCE_TIMEOUT_MS } = await import("../src/services/activityService.js");
const { io: ioClient } = await import("socket.io-client");

let base;
const UA_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const UA_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const call = async (method, url, { token, json, ua } = {}) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (ua) headers["User-Agent"] = ua;
  let body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  const res = await fetch(base + url, { method, headers, body });
  const data = (res.headers.get("content-type") || "").includes("json") ? await res.json() : await res.text();
  return { status: res.status, data };
};

const login = async (email, password, ua = UA_CHROME) => {
  const r = await call("POST", "/api/auth/login", { json: { email, password }, ua });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.data.token;
};

const T = {};
const ID = {};

before(async () => {
  await mongoose.connect(mongod.getUri());
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;

  await User.create({ name: "Root", email: "root@act.io", password: "Root@123", role: "SuperAdmin" });
  const a = await User.create({ name: "Alice Admin", email: "a@act.io", password: "Admin@123", role: "Admin", companyName: "Acme" });
  const b = await User.create({ name: "Bob Admin", email: "b@act.io", password: "Admin@123", role: "Admin", companyName: "Beta" });
  const u1 = await User.create({ name: "Uma", email: "uma@act.io", password: "User@123", role: "User", admin_id: a._id });
  const m1 = await User.create({ name: "Max", email: "max@act.io", password: "User@123", role: "Manager", admin_id: a._id });
  const u2 = await User.create({ name: "Zed", email: "zed@act.io", password: "User@123", role: "User", admin_id: b._id });
  Object.assign(ID, { a: a._id, b: b._id, u1: u1._id, m1: m1._id, u2: u2._id });

  T.super = await login("root@act.io", "Root@123");
  T.adminA = await login("a@act.io", "Admin@123");
  T.adminB = await login("b@act.io", "Admin@123");
  T.uma = await login("uma@act.io", "User@123");
  T.max = await login("max@act.io", "User@123");
  T.zed = await login("zed@act.io", "User@123");
});

after(async () => {
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mongod.stop();
});

describe("login tracking", () => {
  test("every login creates a session with device, IP and a session id in the token", async () => {
    assert.ok(jwt.decode(T.uma).sid, "token carries the session id");
    const s = await UserActivity.findOne({ userId: ID.u1 }).lean();
    assert.equal(s.status, "active");
    assert.equal(s.source, "login");
    assert.equal(String(s.orgId), String(ID.a), "tenant stamped from the user, not the request");
    assert.equal(s.device.browser, "Chrome");
    assert.equal(s.device.os, "Windows");
    assert.ok(s.ip);
    assert.ok((await User.findById(ID.u1).lean()).lastLoginAt);
  });

  test("session key and raw user agent are never returned by the API", async () => {
    const r = await call("GET", "/api/activity/history", { token: T.adminA });
    assert.equal(r.status, 200);
    const text = JSON.stringify(r.data);
    assert.doesNotMatch(text, /sessionKey|userAgent/);
    assert.ok(r.data.data.some((row) => row.current), "the viewer's own session is flagged");
  });

  test("heartbeat works for every role", async () => {
    for (const t of [T.super, T.adminA, T.uma, T.max]) {
      const r = await call("POST", "/api/activity/heartbeat", { token: t, json: { active: true } });
      assert.equal(r.status, 200);
      assert.equal(r.data.data.state, "online");
    }
  });
});

describe("role-based access", () => {
  test("regular Users and Managers cannot use any monitoring API", async () => {
    for (const t of [T.uma, T.max]) {
      for (const url of [
        "/api/activity/summary", "/api/activity/users", "/api/activity/history", "/api/activity/recent",
        `/api/activity/users/${ID.u1}/history`, "/api/activity/organizations", `/api/activity/organizations/${ID.a}`,
      ]) {
        assert.equal((await call("GET", url, { token: t })).status, 403, url);
      }
    }
  });

  test("monitoring needs a login", async () => {
    assert.equal((await call("GET", "/api/activity/summary")).status, 401);
    assert.equal((await call("POST", "/api/activity/heartbeat")).status, 401);
  });

  test("Admin sees only their own organization by default", async () => {
    const users = await call("GET", "/api/activity/users?limit=100", { token: T.adminA });
    assert.equal(users.status, 200);
    const emails = users.data.data.map((u) => u.email).sort();
    assert.deepEqual(emails, ["a@act.io", "max@act.io", "uma@act.io"]);

    const summary = await call("GET", "/api/activity/summary", { token: T.adminA });
    assert.equal(summary.data.data.totalEmployees, 3);
    assert.equal(summary.data.data.scope.global, false);
    assert.equal(summary.data.data.organization.name, "Acme");
    assert.equal(summary.data.data.totalOrganizations, undefined, "no global numbers for an Admin");

    const history = await call("GET", "/api/activity/history?limit=100", { token: T.adminA });
    assert.ok(history.data.data.length > 0);
    assert.ok(history.data.data.every((h) => String(h.organization?._id) === String(ID.a)));
  });

  test("Admin cannot reach another organization by changing parameters", async () => {
    const asB = `orgId=${ID.b}`;
    assert.equal((await call("GET", `/api/activity/users?${asB}`, { token: T.adminA })).status, 403);
    assert.equal((await call("GET", `/api/activity/summary?${asB}`, { token: T.adminA })).status, 403);
    assert.equal((await call("GET", `/api/activity/history?${asB}`, { token: T.adminA })).status, 403);
    assert.equal((await call("GET", `/api/activity/organizations`, { token: T.adminA })).status, 403);
    assert.equal((await call("GET", `/api/activity/organizations/${ID.b}`, { token: T.adminA })).status, 403);
    // another org's user → 404, as if they did not exist
    assert.equal((await call("GET", `/api/activity/users/${ID.u2}/history`, { token: T.adminA })).status, 404);
    // filtering history by another org's user id returns nothing
    const h = await call("GET", `/api/activity/history?userId=${ID.u2}`, { token: T.adminA });
    assert.equal(h.status, 200);
    assert.equal(h.data.data.length, 0);
    // searching finds nobody outside the org
    const s = await call("GET", "/api/activity/users?search=zed", { token: T.adminA });
    assert.equal(s.data.data.length, 0);
  });

  test("SuperAdmin sees every organization and can open one", async () => {
    const summary = await call("GET", "/api/activity/summary", { token: T.super });
    assert.equal(summary.status, 200);
    const d = summary.data.data;
    assert.equal(d.scope.global, true);
    assert.equal(d.totalOrganizations, 2);
    assert.equal(d.totalAdmins, 2);
    assert.equal(d.totalUsers, 3);
    assert.equal(d.totalEmployees, 6);
    assert.ok(d.loginsToday >= 6);

    const orgs = await call("GET", "/api/activity/organizations?sort=name&order=asc", { token: T.super });
    assert.deepEqual(orgs.data.data.map((o) => o.name), ["Acme", "Beta"]);
    assert.equal(orgs.data.data[0].totalUsers, 3);
    assert.equal(orgs.data.data[1].totalUsers, 2);

    const one = await call("GET", `/api/activity/organizations/${ID.b}`, { token: T.super });
    assert.equal(one.data.data.totalEmployees, 2);
    assert.equal(one.data.data.organization.name, "Beta");

    const orgUsers = await call("GET", `/api/activity/users?orgId=${ID.b}`, { token: T.super });
    assert.deepEqual(orgUsers.data.data.map((u) => u.email).sort(), ["b@act.io", "zed@act.io"]);

    const everyone = await call("GET", "/api/activity/users?search=@act.io&limit=100", { token: T.super });
    assert.equal(everyone.data.data.length, 6);
    assert.equal(everyone.data.data.find((u) => u.email === "zed@act.io").organization.name, "Beta");

    const hist = await call("GET", `/api/activity/users/${ID.u2}/history`, { token: T.super });
    assert.equal(hist.status, 200);
    assert.equal(hist.data.user.organization.name, "Beta");

    assert.equal((await call("GET", "/api/activity/users?orgId=nope", { token: T.super })).status, 400);
    assert.equal((await call("GET", `/api/activity/users?orgId=${ID.u1}`, { token: T.super })).status, 404, "not an organization");
  });
});

describe("presence", () => {
  test("two browsers: logging out of one keeps the other online", async () => {
    const phone = await login("uma@act.io", "User@123", UA_IPHONE);
    const before = await call("GET", `/api/activity/users/${ID.u1}/history`, { token: T.adminA });
    assert.equal(before.data.user.activeSessions, 2);
    assert.equal(before.data.data[0].device.type, "Mobile");

    const out = await call("POST", "/api/activity/logout", { token: phone });
    assert.equal(out.data.data.closed, true);

    const afterLogout = await call("GET", `/api/activity/users/${ID.u1}/history`, { token: T.adminA });
    assert.equal(afterLogout.data.user.online, true, "the desktop session is still online");
    assert.equal(afterLogout.data.user.activeSessions, 1);
    const closed = afterLogout.data.data.find((s) => s.device.type === "Mobile");
    assert.equal(closed.status, "logged_out");
    assert.ok(closed.logoutAt);

    // a logged-out session is never revived by its old token
    const beat = await call("POST", "/api/activity/heartbeat", { token: phone, json: {} });
    assert.equal(beat.data.data.state, "logged_out");
  });

  test("status filter: online / offline", async () => {
    const online = await call("GET", "/api/activity/users?status=online&limit=100", { token: T.adminA });
    assert.ok(online.data.data.every((u) => u.online));
    assert.ok(online.data.data.some((u) => u.email === "uma@act.io"));
  });

  test("stopped heartbeat → offline after the timeout; a new heartbeat brings the session back", async () => {
    const old = new Date(Date.now() - PRESENCE_TIMEOUT_MS - 60_000);
    await UserActivity.updateMany({ userId: ID.m1 }, { $set: { lastSeenAt: old } });
    await sweepPresence();

    const s = await UserActivity.findOne({ userId: ID.m1 }).lean();
    assert.equal(s.status, "timed_out");
    assert.equal(s.endedAt.getTime(), old.getTime(), "session ended at the last sign of life");

    const offline = await call("GET", "/api/activity/users?status=offline&limit=100", { token: T.adminA });
    assert.ok(offline.data.data.some((u) => u.email === "max@act.io"));

    const beat = await call("POST", "/api/activity/heartbeat", { token: T.max, json: { active: true } });
    assert.equal(beat.data.data.state, "online");
    assert.equal((await UserActivity.findOne({ userId: ID.m1 }).lean()).status, "active");
  });

  test("expired login token → session expired", async () => {
    await UserActivity.updateMany({ userId: ID.u2 }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await sweepPresence();
    const s = await UserActivity.findOne({ userId: ID.u2 }).lean();
    assert.equal(s.status, "expired");
  });

  test("tokens from before tracking start a 'resumed' session; bot tokens are ignored", async () => {
    const legacy = jwt.sign({ id: String(ID.u2), role: "User" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const r = await call("POST", "/api/activity/heartbeat", { token: legacy, json: {} });
    assert.equal(r.data.data.state, "online");
    assert.equal(await UserActivity.countDocuments({ userId: ID.u2, source: "resumed" }), 1);

    const bot = jwt.sign({ id: String(ID.u2), via: "telegram" }, process.env.JWT_SECRET, { expiresIn: "5m" });
    const countBefore = await UserActivity.countDocuments({ userId: ID.u2 });
    await call("POST", "/api/activity/heartbeat", { token: bot, json: {} });
    assert.equal(await UserActivity.countDocuments({ userId: ID.u2 }), countBefore);
  });

  test("history filters: status, search and date range", async () => {
    const out = await call("GET", "/api/activity/history?status=logged_out", { token: T.adminA });
    assert.ok(out.data.data.length >= 1);
    assert.ok(out.data.data.every((h) => h.status === "logged_out"));

    const byName = await call("GET", "/api/activity/history?search=uma", { token: T.adminA });
    assert.ok(byName.data.data.every((h) => h.user.email === "uma@act.io"));

    const future = await call("GET", "/api/activity/history?from=2999-01-01", { token: T.adminA });
    assert.equal(future.data.data.length, 0);
  });
});

describe("real-time (Socket.IO)", () => {
  const connect = (token) =>
    new Promise((resolve, reject) => {
      const s = ioClient(base, { auth: { token }, transports: ["websocket"], reconnection: false });
      s.on("connect", () => resolve(s));
      s.on("connect_error", reject);
    });
  const waitFor = (socket, pred, ms = 3000) =>
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), ms);
      socket.on("activity:update", (p) => {
        if (pred(p)) {
          clearTimeout(t);
          resolve(p);
        }
      });
    });

  test("Admins get live updates for their own organization only; SuperAdmin gets all", async () => {
    const adminA = await connect(T.adminA);
    const root = await connect(T.super);
    try {
      const aSawZed = waitFor(adminA, (p) => p.userId === String(ID.u2), 1500);
      const rootSawZed = waitFor(root, (p) => p.userId === String(ID.u2) && p.event === "login");
      const aSawUma = waitFor(adminA, (p) => p.userId === String(ID.u1) && p.event === "login");
      await login("zed@act.io", "User@123");
      await login("uma@act.io", "User@123");
      assert.ok(await rootSawZed, "SuperAdmin sees every tenant");
      assert.ok(await aSawUma, "Admin sees their own member");
      assert.equal(await aSawZed, null, "Admin never hears about another organization");
    } finally {
      adminA.close();
      root.close();
    }
  });

  test("closing the browser (socket gone, no heartbeat) marks the session offline", async () => {
    const token = await login("max@act.io", "User@123");
    const key = `s:${jwt.decode(token).sid}`;
    const sock = await connect(token);
    await new Promise((r) => setTimeout(r, 200));
    const find = () => UserActivity.findOne({ sessionKey: key }).lean();
    assert.equal((await find()).status, "active");
    sock.close();
    await new Promise((r) => setTimeout(r, 6000));
    assert.equal((await find()).status, "timed_out");
  });

  test("a page reload (reconnect within the grace period) stays online", async () => {
    const token = await login("max@act.io", "User@123");
    const key = `s:${jwt.decode(token).sid}`;
    const first = await connect(token);
    first.close();
    const second = await connect(token);
    await new Promise((r) => setTimeout(r, 6000));
    assert.equal((await UserActivity.findOne({ sessionKey: key }).lean()).status, "active");
    second.close();
  });
});
