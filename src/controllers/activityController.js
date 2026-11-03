// src/controllers/activityController.js
// Activity Monitoring — login sessions, online presence and statistics.
// Every monitoring query is built from req.activityScope (middleware/activityMiddleware.js),
// which comes from the authenticated user — never from ids sent by the browser.
import mongoose from "mongoose";
import { DateTime } from "luxon";
import User from "../models/User.js";
import UserActivity from "../models/UserActivity.js";
import {
  touchSession,
  recordLogout,
  onlineSessionFilter,
  sessionDurationMs,
  isSessionOnline,
  sessionFromRequest,
  PRESENCE_TIMEOUT_MS,
} from "../services/activityService.js";

/* =========================================================
   HELPERS
========================================================= */

const fail = (res, err, label) => {
  console.error(`${label}:`, err);
  return res.status(500).json({ success: false, message: "Something went wrong while loading activity." });
};

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const zoneOf = (user) => {
  const tz = user?.preferences?.timezone || "Asia/Kolkata";
  return DateTime.local().setZone(tz).isValid ? tz : "UTC";
};

const startOfToday = (user) => DateTime.now().setZone(zoneOf(user)).startOf("day").toJSDate();

// "YYYY-MM-DD" (or ISO) in the viewer's time zone → Date; invalid → null
const parseDay = (value, user, endOfDay = false) => {
  if (!value) return null;
  const d = DateTime.fromISO(String(value), { zone: zoneOf(user) });
  if (!d.isValid) return null;
  return (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? d.endOf("day") : d).toJSDate();
};

const dateRange = (query, user) => {
  const from = parseDay(query.from, user);
  const to = parseDay(query.to, user, true);
  if (!from && !to) return null;
  return { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
};

const pageOf = (query, fallback = 10) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || fallback));
  return { page, limit, skip: (page - 1) * limit };
};

const toId = (v) => (v ? new mongoose.Types.ObjectId(String(v)) : null);

// Accounts inside the scope. An organization = its Admin + every account with admin_id = Admin.
const userFilterFor = (scope) =>
  scope.global ? {} : { $or: [{ _id: toId(scope.orgId) }, { admin_id: toId(scope.orgId) }] };

// Sessions inside the scope (orgId is stamped on each session at login)
const sessionFilterFor = (scope) => (scope.global ? {} : { orgId: toId(scope.orgId) });

const orgIdOfUser = (u) => (u.role === "Admin" ? u._id : u.admin_id || null);

// Organization display names, by id
const orgNames = async (ids) => {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return new Map();
  const admins = await User.find({ _id: { $in: unique } }).select("name companyName").lean();
  return new Map(admins.map((a) => [String(a._id), a.companyName || a.name]));
};

const orgRef = (id, names) => (id ? { _id: String(id), name: names.get(String(id)) || "Unknown organization" } : null);

// Public shape of one session (no session key, no raw user agent)
const shapeSession = (s, names, currentKey, now = Date.now()) => ({
  _id: s._id,
  user: s.userId && typeof s.userId === "object" && s.userId.email
    ? { _id: s.userId._id, name: s.userId.name, email: s.userId.email, role: s.userId.role }
    : { _id: s.userId, name: "Deleted user", email: "", role: s.role },
  organization: orgRef(s.orgId, names),
  role: s.role,
  loginAt: s.loginAt,
  logoutAt: s.logoutAt,
  endedAt: s.endedAt,
  lastSeenAt: s.lastSeenAt,
  lastActivityAt: s.lastActivityAt,
  durationMs: sessionDurationMs(s, now),
  ip: s.ip || "",
  device: s.device || {},
  status: s.status,
  source: s.source,
  online: isSessionOnline(s, now),
  current: Boolean(currentKey && s.sessionKey === currentKey),
});

/* =========================================================
   PRESENCE (any logged-in user)
========================================================= */

// POST /api/activity/heartbeat   { active: boolean }
export const heartbeat = async (req, res) => {
  try {
    const result = await touchSession({ user: req.user, req, interacted: req.body?.active === true });
    return res.json({
      success: true,
      data: { state: result.state, presenceTimeoutSec: Math.round(PRESENCE_TIMEOUT_MS / 1000) },
    });
  } catch (err) {
    return fail(res, err, "Heartbeat");
  }
};

// POST /api/activity/logout — closes only the session of the calling browser
export const logout = async (req, res) => {
  try {
    const closed = await recordLogout({ user: req.user, req });
    return res.json({ success: true, message: "Logout recorded", data: { closed } });
  } catch (err) {
    return fail(res, err, "Activity logout");
  }
};

/* =========================================================
   SUMMARY  (Admin → own org | SuperAdmin → global or one org)
   GET /api/activity/summary[?orgId=]   GET /api/activity/organizations/:orgId
========================================================= */

export const getSummary = async (req, res) => {
  try {
    const scope = req.activityScope;
    const userFilter = userFilterFor(scope);
    const sessionFilter = sessionFilterFor(scope);
    const todayStart = startOfToday(req.user);

    const onlineIds = await UserActivity.distinct("userId", { ...sessionFilter, ...onlineSessionFilter() });

    const [totalEmployees, onlineUsers, loginsToday, usersToday, recent] = await Promise.all([
      User.countDocuments(userFilter),
      User.countDocuments({ ...userFilter, _id: { $in: onlineIds } }),
      UserActivity.countDocuments({ ...sessionFilter, source: "login", loginAt: { $gte: todayStart } }),
      UserActivity.distinct("userId", { ...sessionFilter, loginAt: { $gte: todayStart } }),
      User.find({ ...userFilter, lastActiveAt: { $ne: null } })
        .sort({ lastActiveAt: -1 })
        .limit(6)
        .select("name email role lastActiveAt admin_id")
        .lean(),
    ]);

    const onlineSet = new Set(onlineIds.map(String));
    const data = {
      scope: { global: scope.global, orgId: scope.orgId ? String(scope.orgId) : null },
      totalEmployees,
      onlineUsers,
      offlineUsers: Math.max(0, totalEmployees - onlineUsers),
      loginsToday,
      activeUsersToday: usersToday.length,
      recentActiveUsers: recent.map((u) => ({
        _id: u._id,
        name: u.name,
        email: u.email,
        role: u.role,
        lastActiveAt: u.lastActiveAt,
        online: onlineSet.has(String(u._id)),
      })),
      presenceTimeoutSec: Math.round(PRESENCE_TIMEOUT_MS / 1000),
    };

    if (scope.global) {
      const [totalOrganizations, activeOrganizations, totalUsers, totalSuperAdmins] = await Promise.all([
        User.countDocuments({ role: "Admin" }),
        User.countDocuments({ role: "Admin", status: "Active" }),
        User.countDocuments({ role: { $in: ["Manager", "User"] } }),
        User.countDocuments({ role: "SuperAdmin" }),
      ]);
      Object.assign(data, {
        totalOrganizations,
        activeOrganizations,
        totalAdmins: totalOrganizations, // every Admin account runs one organization
        totalUsers,
        totalSuperAdmins,
      });
    } else {
      const org = await User.findById(scope.orgId).select("name companyName email status").lean();
      data.organization = org
        ? { _id: org._id, name: org.companyName || org.name, adminName: org.name, email: org.email, status: org.status }
        : null;
    }

    return res.json({ success: true, data });
  } catch (err) {
    return fail(res, err, "Activity summary");
  }
};

/* =========================================================
   USER ACTIVITY TABLE
   GET /api/activity/users?search=&status=online|offline&from=&to=&sort=lastLogin|lastActive|name&order=desc|asc&page=&limit=[&orgId=]
   from / to filter on the user's last login.
========================================================= */

const USER_SORTS = { lastLogin: "lastLoginAt", lastActive: "lastActiveAt", name: "name" };

export const listUsers = async (req, res) => {
  try {
    const scope = req.activityScope;
    const { page, limit, skip } = pageOf(req.query);
    const now = Date.now();

    const and = [userFilterFor(scope)];
    const search = String(req.query.search || "").trim().slice(0, 100);
    if (search) {
      const re = new RegExp(escapeRegex(search), "i");
      and.push({ $or: [{ name: re }, { email: re }, ...(scope.global ? [{ companyName: re }] : [])] });
    }
    const range = dateRange(req.query, req.user);
    if (range) and.push({ lastLoginAt: range });
    if (["SuperAdmin", "Admin", "Manager", "User"].includes(req.query.role)) and.push({ role: req.query.role });

    const sortField = USER_SORTS[req.query.sort] || "lastLoginAt";
    const dir = req.query.order === "asc" ? 1 : -1;

    const pipeline = [
      { $match: { $and: and } },
      {
        $lookup: {
          from: UserActivity.collection.name,
          localField: "_id",
          foreignField: "userId",
          pipeline: [{ $match: onlineSessionFilter(now) }, { $project: { _id: 1 } }],
          as: "_onlineSessions",
        },
      },
      { $addFields: { onlineSessions: { $size: "$_onlineSessions" } } },
      { $addFields: { online: { $gt: ["$onlineSessions", 0] } } },
    ];
    if (req.query.status === "online") pipeline.push({ $match: { online: true } });
    if (req.query.status === "offline") pipeline.push({ $match: { online: false } });
    pipeline.push(
      { $sort: { [sortField]: dir, _id: 1 } },
      {
        $facet: {
          rows: [
            { $skip: skip },
            { $limit: limit },
            {
              $project: {
                name: 1, email: 1, role: 1, status: 1, department: 1, admin_id: 1,
                lastLoginAt: 1, lastActiveAt: 1, online: 1, onlineSessions: 1,
              },
            },
          ],
          total: [{ $count: "n" }],
        },
      }
    );

    const [result] = await User.aggregate(pipeline);
    const rows = result?.rows || [];
    const total = result?.total?.[0]?.n || 0;

    // latest session of each listed user → device + session duration
    const latest = rows.length
      ? await UserActivity.aggregate([
          { $match: { userId: { $in: rows.map((r) => r._id) } } },
          { $sort: { loginAt: -1 } },
          { $group: { _id: "$userId", s: { $first: "$$ROOT" } } },
        ])
      : [];
    const latestBy = new Map(latest.map((l) => [String(l._id), l.s]));
    const names = scope.global ? await orgNames(rows.map(orgIdOfUser)) : new Map();

    const data = rows.map((u) => {
      const s = latestBy.get(String(u._id));
      return {
        _id: u._id,
        name: u.name,
        email: u.email,
        role: u.role,
        department: u.department || "",
        accountStatus: u.status,
        organization: scope.global ? orgRef(orgIdOfUser(u), names) : undefined,
        online: u.online,
        activeSessions: u.onlineSessions,
        lastLoginAt: u.lastLoginAt || s?.loginAt || null,
        lastActiveAt: u.lastActiveAt || s?.lastSeenAt || null,
        sessionDurationMs: s ? sessionDurationMs(s, now) : null,
        sessionStatus: s ? (isSessionOnline(s, now) ? "online" : s.status) : null,
        device: s?.device || null,
      };
    });

    return res.json({
      success: true,
      data,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (err) {
    return fail(res, err, "Activity users");
  }
};

/* =========================================================
   LOGIN HISTORY
   GET /api/activity/history?search=&status=all|online|active|logged_out|timed_out|expired&from=&to=&userId=&page=&limit=[&orgId=]
   GET /api/activity/recent?limit=          (latest logins)
   GET /api/activity/users/:userId/history  (one person)
========================================================= */

const findHistory = async (req, { filter, page, limit, skip }) => {
  const currentKey = sessionFromRequest(req)?.key;
  const [rows, total] = await Promise.all([
    UserActivity.find(filter)
      .select("+sessionKey")
      .sort({ loginAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .populate("userId", "name email role")
      .lean(),
    UserActivity.countDocuments(filter),
  ]);
  const names = await orgNames(rows.map((r) => r.orgId));
  const now = Date.now();
  return {
    data: rows.map((r) => shapeSession(r, names, currentKey, now)),
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
};

// Filter for sessions in scope + query filters. Returns null when nothing can match.
const historyFilter = async (req, extra = {}) => {
  const scope = req.activityScope;
  const and = [sessionFilterFor(scope), extra];

  const search = String(req.query.search || "").trim().slice(0, 100);
  if (search) {
    const re = new RegExp(escapeRegex(search), "i");
    const ids = await User.find({ $and: [userFilterFor(scope), { $or: [{ name: re }, { email: re }] }] })
      .select("_id")
      .limit(1000)
      .lean();
    if (!ids.length) return null;
    and.push({ userId: { $in: ids.map((u) => u._id) } });
  }

  const range = dateRange(req.query, req.user);
  if (range) and.push({ loginAt: range });

  const status = String(req.query.status || "all");
  if (status === "online") and.push(onlineSessionFilter());
  else if (["active", "logged_out", "timed_out", "expired"].includes(status)) and.push({ status });

  return { $and: and };
};

const emptyPage = (page, limit) => ({ data: [], pagination: { page, limit, total: 0, totalPages: 1 } });

export const listHistory = async (req, res) => {
  try {
    const paging = pageOf(req.query, 20);
    let extra = {};
    if (req.query.userId) {
      if (!mongoose.isValidObjectId(req.query.userId)) {
        return res.status(400).json({ success: false, message: "Invalid user id." });
      }
      extra = { userId: toId(req.query.userId) };
    }
    const filter = await historyFilter(req, extra);
    const result = filter ? await findHistory(req, { ...paging, filter }) : emptyPage(paging.page, paging.limit);
    return res.json({ success: true, ...result });
  } catch (err) {
    return fail(res, err, "Login history");
  }
};

export const recentLogins = async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const filter = { ...sessionFilterFor(req.activityScope), source: "login" };
    const result = await findHistory(req, { filter, page: 1, limit, skip: 0 });
    return res.json({ success: true, data: result.data });
  } catch (err) {
    return fail(res, err, "Recent logins");
  }
};

export const getUserHistory = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ success: false, message: "Invalid user id." });
    }
    const scope = req.activityScope;
    // the person must be inside the viewer's scope — otherwise behave as if they do not exist
    const person = await User.findOne({ $and: [userFilterFor(scope), { _id: toId(userId) }] })
      .select("name email role department status admin_id lastLoginAt lastActiveAt")
      .lean();
    if (!person) return res.status(404).json({ success: false, message: "User not found." });

    const paging = pageOf(req.query, 10);
    const filter = await historyFilter(req, { userId: person._id });
    const result = filter ? await findHistory(req, { ...paging, filter }) : emptyPage(paging.page, paging.limit);

    const since = DateTime.now().minus({ days: 30 }).toJSDate();
    const [stats] = await UserActivity.aggregate([
      { $match: { userId: person._id } },
      {
        $group: {
          _id: null,
          totalSessions: { $sum: 1 },
          sessionsLast30Days: { $sum: { $cond: [{ $gte: ["$loginAt", since] }, 1, 0] } },
          avgDurationMs: {
            $avg: {
              $cond: [
                { $eq: ["$status", "active"] },
                null,
                { $subtract: [{ $ifNull: ["$endedAt", "$lastSeenAt"] }, "$loginAt"] },
              ],
            },
          },
        },
      },
    ]);
    const online = await UserActivity.countDocuments({ userId: person._id, ...onlineSessionFilter() });
    const names = await orgNames([orgIdOfUser(person)]);

    return res.json({
      success: true,
      user: {
        _id: person._id,
        name: person.name,
        email: person.email,
        role: person.role,
        department: person.department || "",
        accountStatus: person.status,
        organization: orgRef(orgIdOfUser(person), names),
        lastLoginAt: person.lastLoginAt,
        lastActiveAt: person.lastActiveAt,
        online: online > 0,
        activeSessions: online,
      },
      stats: {
        totalSessions: stats?.totalSessions || 0,
        sessionsLast30Days: stats?.sessionsLast30Days || 0,
        avgDurationMs: stats?.avgDurationMs ? Math.round(stats.avgDurationMs) : null,
      },
      ...result,
    });
  } catch (err) {
    return fail(res, err, "User login history");
  }
};

/* =========================================================
   ORGANIZATIONS (SuperAdmin only)
   GET /api/activity/organizations?search=&status=Active|Inactive&sort=name|totalUsers|online|lastActivity|loginsToday&order=&page=&limit=
========================================================= */

const ORG_SORTS = ["name", "totalUsers", "onlineUsers", "lastActivity", "loginsToday"];

export const listOrganizations = async (req, res) => {
  try {
    const { page, limit, skip } = pageOf(req.query);
    const filter = { role: "Admin" };
    const search = String(req.query.search || "").trim().slice(0, 100);
    if (search) {
      const re = new RegExp(escapeRegex(search), "i");
      filter.$or = [{ name: re }, { companyName: re }, { email: re }];
    }
    if (["Active", "Inactive"].includes(req.query.status)) filter.status = req.query.status;

    const admins = await User.find(filter).select("name companyName email status createdAt lastActiveAt").lean();
    const ids = admins.map((a) => a._id);
    const todayStart = startOfToday(req.user);

    const [members, online, today] = ids.length
      ? await Promise.all([
          User.aggregate([
            { $match: { admin_id: { $in: ids } } },
            { $group: { _id: "$admin_id", n: { $sum: 1 }, lastActive: { $max: "$lastActiveAt" } } },
          ]),
          UserActivity.aggregate([
            { $match: { orgId: { $in: ids }, ...onlineSessionFilter() } },
            { $group: { _id: "$orgId", users: { $addToSet: "$userId" } } },
            { $project: { n: { $size: "$users" } } },
          ]),
          UserActivity.aggregate([
            { $match: { orgId: { $in: ids }, source: "login", loginAt: { $gte: todayStart } } },
            { $group: { _id: "$orgId", n: { $sum: 1 } } },
          ]),
        ])
      : [[], [], []];

    const byId = (list) => new Map(list.map((x) => [String(x._id), x]));
    const m = byId(members);
    const o = byId(online);
    const t = byId(today);

    let rows = admins.map((a) => {
      const id = String(a._id);
      const totalUsers = (m.get(id)?.n || 0) + 1; // members + the Admin
      const onlineUsers = o.get(id)?.n || 0;
      const times = [a.lastActiveAt, m.get(id)?.lastActive].filter(Boolean).map((d) => new Date(d).getTime());
      return {
        _id: a._id,
        name: a.companyName || a.name,
        adminName: a.name,
        email: a.email,
        status: a.status,
        createdAt: a.createdAt,
        totalUsers,
        onlineUsers,
        offlineUsers: Math.max(0, totalUsers - onlineUsers),
        loginsToday: t.get(id)?.n || 0,
        lastActivity: times.length ? new Date(Math.max(...times)) : null,
      };
    });

    const sort = ORG_SORTS.includes(req.query.sort) ? req.query.sort : "onlineUsers";
    const dir = req.query.order === "asc" ? 1 : -1;
    const value = (r) => (sort === "name" ? r.name.toLowerCase() : sort === "lastActivity" ? r.lastActivity?.getTime() || 0 : r[sort]);
    rows.sort((a, b) => (value(a) > value(b) ? dir : value(a) < value(b) ? -dir : a.name.localeCompare(b.name)));

    const total = rows.length;
    rows = rows.slice(skip, skip + limit);

    return res.json({
      success: true,
      data: rows,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (err) {
    return fail(res, err, "Activity organizations");
  }
};
