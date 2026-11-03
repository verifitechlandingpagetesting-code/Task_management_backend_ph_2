// Individual (per-person) reports: assigned / completed / pending / in progress / overdue,
// on-time rate and average completion time — for every user of the requester's organization.
import mongoose from "mongoose";
import Task from "../models/Task.js";
import User from "../models/User.js";
import { parseDateRange } from "../utils/dateRange.js";
import { MEMBER_ROLES, ROLE_LABELS } from "../config/permissions.js";

const orgFilter = (orgId) => ({
  $or: [{ _id: orgId }, { admin_id: orgId }, { createdBy: orgId, admin_id: null }],
});

const parseRange = (q) => {
  if (q.from || q.to) {
    const start = q.from ? new Date(`${q.from}T00:00:00.000Z`) : null;
    const end = q.to ? new Date(`${q.to}T23:59:59.999Z`) : null;
    return { start: start && !isNaN(start) ? start : null, end: end && !isNaN(end) ? end : null };
  }
  return parseDateRange(q.dateRange || "all_time") || { start: null, end: null };
};

// GET /api/reports/individual?userId=&department=&role=&dateRange=&from=&to=&adminId=
export const getIndividualReport = async (req, res) => {
  try {
    const q = req.query;
    const isSuper = req.user.role === "SuperAdmin";
    const orgId = isSuper ? (mongoose.isValidObjectId(q.adminId) ? q.adminId : null) : req.adminId;

    // ---- people in scope ----
    const userFilter = { status: { $in: ["Active", "Inactive"] } };
    if (orgId) Object.assign(userFilter, orgFilter(orgId));
    else userFilter.role = { $ne: "SuperAdmin" };
    // Managers report on their own department; Team Members only on themselves
    if (req.user.role === "Manager" && req.user.department) userFilter.department = req.user.department;
    if (req.user.role === "User") userFilter._id = req.user._id;

    if (q.department && q.department !== "All Departments") userFilter.department = q.department;
    if (q.role && q.role !== "All Roles") {
      if (String(q.role).startsWith("custom:")) {
        const id = q.role.slice(7);
        if (mongoose.isValidObjectId(id)) userFilter.customRole = id;
      } else if (["Admin", ...MEMBER_ROLES].includes(q.role)) {
        userFilter.role = q.role;
        if (q.role !== "Admin") userFilter.customRole = null;
      }
    }
    if (q.userId) {
      if (!mongoose.isValidObjectId(q.userId)) return res.status(400).json({ success: false, message: "Invalid user" });
      userFilter._id = userFilter._id && String(userFilter._id) !== String(q.userId) ? null : q.userId;
    }

    const people = await User.find(userFilter)
      .select("name email department role status points customRole admin_id")
      .populate("customRole", "name")
      .sort({ name: 1 })
      .lean();
    const ids = people.map((p) => p._id);

    // ---- tasks of those people (in the date range, by creation date) ----
    const { start, end } = parseRange(q);
    const match = { isTaskBank: { $ne: true }, assignedTo: { $in: ids } };
    if (orgId) match.admin_id = new mongoose.Types.ObjectId(String(orgId));
    if (start || end) {
      match.createdAt = {};
      if (start) match.createdAt.$gte = start;
      if (end) match.createdAt.$lte = end;
    }
    const now = new Date();

    const rows = await Task.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$assignedTo",
          total: { $sum: 1 },
          todo: { $sum: { $cond: [{ $eq: ["$status", "To Do"] }, 1, 0] } },
          inProgress: { $sum: { $cond: [{ $eq: ["$status", "In Progress"] }, 1, 0] } },
          review: { $sum: { $cond: [{ $eq: ["$status", "Review"] }, 1, 0] } },
          completed: { $sum: { $cond: [{ $eq: ["$status", "Completed"] }, 1, 0] } },
          overdue: {
            $sum: {
              $cond: [{ $and: [{ $ne: ["$status", "Completed"] }, { $ne: ["$dueDate", null] }, { $lt: ["$dueDate", now] }] }, 1, 0],
            },
          },
          completedWithDue: {
            $sum: { $cond: [{ $and: [{ $eq: ["$status", "Completed"] }, { $ne: ["$dueDate", null] }, { $ne: ["$completedAt", null] }] }, 1, 0] },
          },
          // due dates are whole days → on time = completed before the END of that day
          onTime: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$status", "Completed"] },
                    { $ne: ["$dueDate", null] },
                    { $ne: ["$completedAt", null] },
                    { $lte: ["$completedAt", { $add: ["$dueDate", 86399999] }] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          completionMs: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ["$status", "Completed"] }, { $ne: ["$completedAt", null] }] },
                { $subtract: ["$completedAt", { $ifNull: ["$assignedAt", "$createdAt"] }] },
                0,
              ],
            },
          },
          completedWithTime: {
            $sum: { $cond: [{ $and: [{ $eq: ["$status", "Completed"] }, { $ne: ["$completedAt", null] }] }, 1, 0] },
          },
          points: { $sum: { $cond: [{ $eq: ["$status", "Completed"] }, "$reward", 0] } },
        },
      },
    ]);
    const byUser = Object.fromEntries(rows.map((r) => [String(r._id), r]));

    const data = people.map((p) => {
      const r = byUser[String(p._id)] || {};
      const total = r.total || 0;
      const completed = r.completed || 0;
      return {
        userId: p._id,
        name: p.name,
        email: p.email,
        department: p.department || "",
        role: p.role,
        roleLabel: p.customRole?.name || ROLE_LABELS[p.role] || p.role,
        status: p.status,
        assigned: total,
        completed,
        pending: r.todo || 0,
        inProgress: r.inProgress || 0,
        review: r.review || 0,
        overdue: r.overdue || 0,
        completionRate: total ? Math.round((completed / total) * 100) : 0,
        onTimeRate: r.completedWithDue ? Math.round(((r.onTime || 0) / r.completedWithDue) * 100) : null,
        avgCompletionHours: r.completedWithTime ? Math.round((r.completionMs / r.completedWithTime / 36e5) * 10) / 10 : null,
        pointsEarned: r.points || 0,
      };
    });

    // Detail for one person: their tasks in the range
    let tasks = [];
    if (q.userId && ids.length) {
      tasks = await Task.find({ ...match, assignedTo: ids[0] })
        .select("name status priority dueDate completedAt createdAt department")
        .sort({ createdAt: -1 })
        .limit(200)
        .lean();
    }

    const totals = data.reduce(
      (t, d) => ({
        people: t.people + 1,
        assigned: t.assigned + d.assigned,
        completed: t.completed + d.completed,
        pending: t.pending + d.pending,
        inProgress: t.inProgress + d.inProgress,
        overdue: t.overdue + d.overdue,
      }),
      { people: 0, assigned: 0, completed: 0, pending: 0, inProgress: 0, overdue: 0 }
    );

    res.json({
      success: true,
      data: {
        people: data,
        totals: { ...totals, completionRate: totals.assigned ? Math.round((totals.completed / totals.assigned) * 100) : 0 },
        tasks,
        range: { start, end },
      },
    });
  } catch (err) {
    console.error("Individual report error:", err);
    res.status(500).json({ success: false, message: "Failed to build the individual report" });
  }
};
