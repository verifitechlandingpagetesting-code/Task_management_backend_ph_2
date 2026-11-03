// src/middleware/activityMiddleware.js
import mongoose from "mongoose";
import User from "../models/User.js";
import { sessionFromRequest, touchSession, TOUCH_THROTTLE_MS } from "../services/activityService.js";

/* =========================================================
   1) trackActivity — runs on every protected API call (after authenticate).
      Refreshes "last active" for the caller's session, at most once per
      TOUCH_THROTTLE_MS per session. Never delays or fails the request.
========================================================= */

const lastTouch = new Map(); // sessionKey → ms
const SKIP = /^\/api\/activity\/(heartbeat|logout)\b/; // these record presence themselves

setInterval(() => {
  const cutoff = Date.now() - TOUCH_THROTTLE_MS * 2;
  for (const [key, at] of lastTouch) if (at < cutoff) lastTouch.delete(key);
}, 10 * 60 * 1000).unref();

export const trackActivity = (req, res, next) => {
  try {
    if (req.user && !SKIP.test(req.originalUrl || "")) {
      const session = sessionFromRequest(req);
      const now = Date.now();
      if (session && now - (lastTouch.get(session.key) || 0) >= TOUCH_THROTTLE_MS) {
        lastTouch.set(session.key, now);
        // a change (create / update / delete) means the person is using the app;
        // reads alone may be background polling, so they only prove presence
        const interacted = req.method !== "GET" && req.method !== "HEAD";
        touchSession({ user: req.user, req, session, interacted }).catch((err) =>
          console.error("activity touch:", err.message)
        );
      }
    }
  } catch (err) {
    console.error("activity tracking:", err.message);
  }
  next();
};

/* =========================================================
   2) requireActivityAccess — Activity Monitoring is for SuperAdmin + Admin only.
      Managers and regular Users get 403 on every monitoring API.
========================================================= */

export const ACTIVITY_ROLES = ["SuperAdmin", "Admin"];

export const requireActivityAccess = (req, res, next) => {
  if (!ACTIVITY_ROLES.includes(req.user?.role)) {
    return res.status(403).json({
      success: false,
      message: "Activity monitoring is available to administrators only.",
    });
  }
  next();
};

export const requireSuperAdmin = (req, res, next) => {
  if (req.user?.role !== "SuperAdmin") {
    return res.status(403).json({ success: false, message: "Super Admin access required." });
  }
  next();
};

/* =========================================================
   3) resolveActivityScope — WHICH organization the request may see.
      Decided from the authenticated user only:
        Admin      → always their own organization (their _id). An orgId in the
                     URL/query that is not their own → 403.
        SuperAdmin → every organization, or one organization when ?orgId= (or
                     :orgId) names an existing Admin account.
      req.activityScope = { global: boolean, orgId: ObjectId | null }
========================================================= */

export const resolveActivityScope = async (req, res, next) => {
  try {
    const requested = req.params?.orgId || req.query?.orgId || "";
    const { user } = req;

    if (user.role === "Admin") {
      if (requested && String(requested) !== String(user._id)) {
        return res.status(403).json({
          success: false,
          message: "You can only view your own organization's activity.",
        });
      }
      req.activityScope = { global: false, orgId: user._id };
      return next();
    }

    if (user.role === "SuperAdmin") {
      if (!requested || requested === "all") {
        req.activityScope = { global: true, orgId: null };
        return next();
      }
      if (!mongoose.isValidObjectId(requested)) {
        return res.status(400).json({ success: false, message: "Invalid organization id." });
      }
      const org = await User.findOne({ _id: requested, role: "Admin" }).select("_id").lean();
      if (!org) return res.status(404).json({ success: false, message: "Organization not found." });
      req.activityScope = { global: false, orgId: org._id };
      return next();
    }

    return res.status(403).json({ success: false, message: "Activity monitoring is available to administrators only." });
  } catch (err) {
    next(err);
  }
};
