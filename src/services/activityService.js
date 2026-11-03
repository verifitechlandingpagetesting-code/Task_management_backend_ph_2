// src/services/activityService.js
// Login sessions + online presence for the Activity Monitoring dashboards.
//
// How presence works
//   • login            → a UserActivity session is created; its id (`sid`) goes into the JWT
//   • heartbeat        → the browser calls POST /api/activity/heartbeat every ~30 s
//   • any API call     → middleware/activityMiddleware.js refreshes the session (throttled)
//   • Socket.IO        → a connected socket keeps its session alive; when the LAST socket of a
//                        session disconnects (tab/browser closed) the session goes offline after
//                        a short grace period (a page reload reconnects within it)
//   • sweep (1/min)    → sessions with no sign of life for PRESENCE_TIMEOUT → "timed_out",
//                        sessions whose JWT expired → "expired"
//   • logout           → "logged_out"
// A user is online while at least one of their sessions is online, so several browsers /
// devices never mark each other offline.
import crypto from "crypto";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import UserActivity from "../models/UserActivity.js";
import User from "../models/User.js";

const seconds = (name, fallback, min) => {
  const v = Number(process.env[name]);
  return (Number.isFinite(v) && v >= min ? v : fallback) * 1000;
};

// No heartbeat / API call / socket for this long → offline
export const PRESENCE_TIMEOUT_MS = seconds("ACTIVITY_PRESENCE_TIMEOUT_SEC", 120, 30);
// Last socket of a session closed → offline after this grace (reloads reconnect within it)
export const DISCONNECT_GRACE_MS = seconds("ACTIVITY_DISCONNECT_GRACE_SEC", 30, 5);
// API calls refresh a session at most this often (keeps writes low)
export const TOUCH_THROTTLE_MS = seconds("ACTIVITY_TOUCH_THROTTLE_SEC", 60, 5);

export const onlineCutoff = (now = Date.now()) => new Date(now - PRESENCE_TIMEOUT_MS);

// Mongo filter for "this session is online right now"
export const onlineSessionFilter = (now = Date.now()) => ({
  status: "active",
  lastSeenAt: { $gte: onlineCutoff(now) },
});

/* ---------------- tenant ---------------- */

// The organization (tenant) an account belongs to — never taken from the request.
export const orgIdOf = (user) => {
  if (!user) return null;
  if (user.role === "SuperAdmin") return null;
  if (user.role === "Admin") return user._id;
  return user.admin_id || null;
};

/* ---------------- request details ---------------- */

// Small, dependency-free user-agent summary (browser / OS / device type)
export const parseUserAgent = (ua = "") => {
  const s = String(ua);
  const pick = (rules) => rules.find(([re]) => re.test(s))?.[1] || "Unknown";

  const browser = pick([
    [/Edg(e|A|iOS)?\//, "Edge"],
    [/OPR\/|Opera/, "Opera"],
    [/SamsungBrowser\//, "Samsung Internet"],
    [/Firefox\/|FxiOS\//, "Firefox"],
    [/CriOS\/|Chrome\//, "Chrome"],
    [/Safari\//, "Safari"],
    [/node|undici|axios|curl|PostmanRuntime/i, "API client"],
  ]);
  const os = pick([
    [/Windows NT/, "Windows"],
    [/iPhone|iPad|iPod/, "iOS"],
    [/Android/, "Android"],
    [/CrOS/, "ChromeOS"],
    [/Mac OS X|Macintosh/, "macOS"],
    [/Linux/, "Linux"],
  ]);
  const type = /iPad|Tablet/i.test(s) || (/Android/.test(s) && !/Mobile/.test(s))
    ? "Tablet"
    : /Mobi|iPhone|iPod|Android/i.test(s)
      ? "Mobile"
      : "Desktop";

  return { browser, os, type };
};

// Client IP. Render / Vercel put the visitor's address first in X-Forwarded-For.
export const clientIp = (req) => {
  const fwd = String(req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  const raw = fwd || req?.socket?.remoteAddress || req?.ip || "";
  return String(raw).replace(/^::ffff:/, "").slice(0, 64);
};

/* ---------------- session identity (from the JWT) ---------------- */

export const newSessionId = () => crypto.randomUUID();

const bearerOf = (req) => {
  const header = req?.headers?.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
};

// Session key + expiry of an (already verified) token.
// Tokens issued before tracking existed have no `sid` → keyed by a hash of the token itself.
export const sessionFromToken = (token) => {
  if (!token) return null;
  const decoded = jwt.decode(token) || {};
  // Internal service tokens (e.g. the Telegram bot calling the API as a user, `via: "telegram"`)
  // are not browser sessions — they never count as a login or as being online.
  if (decoded.via) return null;
  const key = decoded.sid
    ? `s:${decoded.sid}`
    : `t:${crypto.createHash("sha256").update(token).digest("hex").slice(0, 40)}`;
  return { key, expiresAt: decoded.exp ? new Date(decoded.exp * 1000) : null };
};

export const sessionFromRequest = (req) => sessionFromToken(bearerOf(req));

/* ---------------- real-time updates (Socket.IO) ---------------- */

let ioRef = null;
export const setActivityIO = (io) => {
  ioRef = io;
};

export const GLOBAL_ROOM = "activity:global"; // every SuperAdmin
export const orgRoom = (orgId) => `activity:org:${String(orgId)}`; // that organization's Admin

// Tell the dashboards that may see this user that something changed.
// Payload carries ids + state only (no IP / device details).
export const emitActivity = (orgId, payload) => {
  if (!ioRef) return;
  const body = { ...payload, at: new Date().toISOString() };
  let target = ioRef.to(GLOBAL_ROOM);
  if (orgId) target = target.to(orgRoom(orgId));
  target.emit("activity:update", body);
};

const emitFor = (session, event) =>
  emitActivity(session.orgId, {
    event,
    userId: String(session.userId),
    orgId: session.orgId ? String(session.orgId) : null,
  });

/* ---------------- sessions ---------------- */

// Successful login → new session + user's lastLoginAt. `token` is the JWT just issued.
export const recordLogin = async ({ user, token, req }) => {
  const now = new Date();
  const ua = String(req?.headers?.["user-agent"] || "").slice(0, 512);
  const { key, expiresAt } = sessionFromToken(token);

  const session = await UserActivity.create({
    sessionKey: key,
    userId: user._id,
    orgId: orgIdOf(user),
    role: user.role,
    loginAt: now,
    lastSeenAt: now,
    lastActivityAt: now,
    expiresAt,
    source: "login",
    ip: clientIp(req),
    userAgent: ua,
    device: parseUserAgent(ua),
  });
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: now, lastActiveAt: now } });
  emitFor(session, "login");
  return session;
};

// Find the session behind this token; create it for older tokens (issued before tracking).
const findOrCreateSession = async ({ user, key, expiresAt, req }) => {
  const existing = await UserActivity.findOne({ sessionKey: key });
  if (existing) return { session: existing, created: false };

  const ua = String(req?.headers?.["user-agent"] || "").slice(0, 512);
  const now = new Date();
  try {
    const session = await UserActivity.create({
      sessionKey: key,
      userId: user._id,
      orgId: orgIdOf(user),
      role: user.role,
      loginAt: now,
      lastSeenAt: now,
      lastActivityAt: now,
      expiresAt,
      source: "resumed",
      ip: clientIp(req),
      userAgent: ua,
      device: parseUserAgent(ua),
    });
    return { session, created: true };
  } catch (err) {
    if (err?.code === 11000) {
      // another request created it at the same moment
      return { session: await UserActivity.findOne({ sessionKey: key }), created: false };
    }
    throw err;
  }
};

/**
 * Sign of life for the session behind `req` (heartbeat, API call, socket).
 * interacted → the person actually used the app (updates "last activity").
 * Returns { state: "online" | "logged_out" | "expired" }.
 */
export const touchSession = async ({ user, req, session: sessionInfo, interacted = false }) => {
  const info = sessionInfo || sessionFromRequest(req);
  if (!user || !info?.key) return { state: "unknown" };

  const now = new Date();
  const { session, created } = await findOrCreateSession({ user, key: info.key, expiresAt: info.expiresAt, req });
  if (!session) return { state: "unknown" };
  // the token belongs to a different account → never mix sessions up
  if (String(session.userId) !== String(user._id)) return { state: "unknown" };

  if (session.status === "logged_out") return { state: "logged_out" };
  if (session.status === "expired" || (session.expiresAt && session.expiresAt <= now)) {
    if (session.status !== "expired") await expireSessions([session], now);
    return { state: "expired" };
  }

  const wasOnline = !created && session.status === "active" && session.lastSeenAt >= onlineCutoff(now.getTime());
  const set = { lastSeenAt: now };
  if (interacted) set.lastActivityAt = now;
  if (session.status === "timed_out") {
    // came back (laptop woke up, network returned) → the same session continues
    set.status = "active";
    set.endedAt = null;
  }
  await UserActivity.updateOne({ _id: session._id }, { $set: set });
  if (interacted || created) {
    await User.updateOne({ _id: user._id }, { $set: { lastActiveAt: now } });
  }
  if (!wasOnline) emitFor(session, "online");
  return { state: "online" };
};

// Logout → close only THIS browser's session
export const recordLogout = async ({ user, req }) => {
  const info = sessionFromRequest(req);
  if (!user || !info?.key) return false;
  const now = new Date();
  const session = await UserActivity.findOneAndUpdate(
    { sessionKey: info.key, userId: user._id, status: { $in: ["active", "timed_out"] } },
    { $set: { status: "logged_out", logoutAt: now, endedAt: now, lastSeenAt: now } },
    { new: true }
  );
  if (session) {
    await User.updateOne({ _id: user._id }, { $set: { lastActiveAt: now } });
    emitFor(session, "logout");
  }
  return Boolean(session);
};

const expireSessions = async (sessions, now = new Date()) => {
  if (!sessions.length) return;
  await UserActivity.updateMany(
    { _id: { $in: sessions.map((s) => s._id) } },
    [{ $set: { status: "expired", endedAt: { $min: ["$lastSeenAt", "$expiresAt", now] } } }]
  );
  sessions.forEach((s) => emitFor(s, "offline"));
};

/* ---------------- sockets (in-memory, per server instance) ---------------- */

const socketsBySession = new Map(); // sessionKey → Set(socketId)
const graceTimers = new Map(); // sessionKey → timeout

export const liveSessionKeys = () => [...socketsBySession.keys()];

export const socketConnected = async (socket) => {
  const info = sessionFromToken(socket.handshake?.auth?.token);
  if (!info) return;
  socket.data.activityKey = info.key;
  const set = socketsBySession.get(info.key) || new Set();
  set.add(socket.id);
  socketsBySession.set(info.key, set);
  clearTimeout(graceTimers.get(info.key));
  graceTimers.delete(info.key);
  const fakeReq = { headers: { ...socket.handshake.headers, authorization: `Bearer ${socket.handshake.auth.token}` }, socket: { remoteAddress: socket.handshake.address } };
  await touchSession({ user: socket.user, req: fakeReq, session: info });
};

export const socketDisconnected = (socket) => {
  const key = socket.data?.activityKey;
  if (!key) return;
  const set = socketsBySession.get(key);
  set?.delete(socket.id);
  if (set && set.size) return; // another tab of this session is still open
  socketsBySession.delete(key);

  const closedAt = new Date();
  clearTimeout(graceTimers.get(key));
  const timer = setTimeout(async () => {
    graceTimers.delete(key);
    if (socketsBySession.has(key)) return; // reconnected (page reload)
    try {
      // no heartbeat since the socket closed → the browser is gone
      const session = await UserActivity.findOneAndUpdate(
        { sessionKey: key, status: "active", lastSeenAt: { $lte: closedAt } },
        { $set: { status: "timed_out", endedAt: closedAt, lastSeenAt: closedAt } },
        { new: true }
      );
      if (session) emitFor(session, "offline");
    } catch (err) {
      console.error("activity disconnect:", err.message);
    }
  }, DISCONNECT_GRACE_MS);
  timer.unref?.();
  graceTimers.set(key, timer);
};

/* ---------------- background sweep ---------------- */

// Run every minute (jobs/activityPresenceJob.js). Returns how many sessions went offline.
export const sweepPresence = async (now = new Date()) => {
  if (mongoose.connection.readyState !== 1) return 0;

  // sessions with an open socket on this server are alive
  const live = liveSessionKeys();
  if (live.length) {
    await UserActivity.updateMany({ sessionKey: { $in: live }, status: "active" }, { $set: { lastSeenAt: now } });
  }

  const expired = await UserActivity.find({ status: { $in: ["active", "timed_out"] }, expiresAt: { $ne: null, $lte: now } })
    .select("_id userId orgId")
    .limit(2000)
    .lean();
  await expireSessions(expired, now);

  const stale = await UserActivity.find({ status: "active", lastSeenAt: { $lt: onlineCutoff(now.getTime()) } })
    .select("_id userId orgId lastSeenAt")
    .limit(2000)
    .lean();
  if (stale.length) {
    await UserActivity.updateMany(
      { _id: { $in: stale.map((s) => s._id) }, status: "active" },
      [{ $set: { status: "timed_out", endedAt: "$lastSeenAt" } }]
    );
    stale.forEach((s) => emitFor(s, "offline"));
  }
  return expired.length + stale.length;
};

/* ---------------- shared helpers ---------------- */

// Duration of a session in ms (still running → until now)
export const sessionDurationMs = (s, now = Date.now()) => {
  if (!s?.loginAt) return 0;
  const end = isSessionOnline(s, now) ? now : new Date(s.endedAt || s.logoutAt || s.lastSeenAt).getTime();
  return Math.max(0, end - new Date(s.loginAt).getTime());
};

export const isSessionOnline = (s, now = Date.now()) =>
  s?.status === "active" && new Date(s.lastSeenAt).getTime() >= now - PRESENCE_TIMEOUT_MS;
