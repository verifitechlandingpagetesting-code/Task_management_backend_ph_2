import {
  setActivityIO,
  socketConnected,
  socketDisconnected,
  GLOBAL_ROOM,
  orgRoom,
} from "../services/activityService.js";

/* =========================================================
   Activity Monitoring over the shared, authenticated Socket.IO connection
   (socket.user is set by the auth middleware in Chatsocket.js).
   • every socket keeps its login session online; closing the last tab of a
     session marks it offline after a short grace period
   • SuperAdmins join "activity:global", Admins join "activity:org:<their id>"
     and receive "activity:update" { event, userId, orgId, at } when someone in
     their scope logs in / out or goes online / offline.
   Managers and Users join no monitoring room.
========================================================= */

export const registerActivitySocket = (io) => {
  setActivityIO(io);

  io.on("connection", (socket) => {
    const user = socket.user;
    if (!user) return;

    if (user.role === "SuperAdmin") socket.join(GLOBAL_ROOM);
    else if (user.role === "Admin") socket.join(orgRoom(user._id));

    socketConnected(socket).catch((err) => console.error("activity socket:", err.message));
    socket.on("disconnect", () => socketDisconnected(socket));
  });
};
