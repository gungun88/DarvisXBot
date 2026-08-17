import { Navigate, Route, Routes } from "react-router-dom";
import { getAdminUser, hasToken } from "./api";
import { Shell } from "./components/Shell";
import { LoginPage } from "./pages/Login";
import { DashboardPage } from "./pages/Dashboard";
import { ChatsPage, ChatDetailPage } from "./pages/Chats";
import { UsersPage, UserDetailPage } from "./pages/Users";
import { ScheduledPage } from "./pages/Scheduled";
import { GiveawaysPage } from "./pages/Giveaways";
import { PointsPage } from "./pages/Points";
import { AuditPage } from "./pages/Audit";
import { OperationsPage } from "./pages/Operations";
import { MembershipsPage } from "./pages/Memberships";
import { ModerationPage } from "./pages/Moderation";
import { AdminAccountsPage } from "./pages/AdminAccounts";

function ProtectedShell() {
  return hasToken() ? <Shell /> : <Navigate to="/login" replace />;
}

function OwnerPage() {
  return getAdminUser()?.role === "owner" ? <AdminAccountsPage /> : <Navigate to="/dashboard" replace />;
}

export function App() {
  return <Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route element={<ProtectedShell />}>
      <Route path="/dashboard" element={<DashboardPage />} />
      <Route path="/chats" element={<ChatsPage />} />
      <Route path="/chats/:id" element={<ChatDetailPage />} />
      <Route path="/users" element={<UsersPage />} />
      <Route path="/users/:id" element={<UserDetailPage />} />
      <Route path="/memberships" element={<MembershipsPage />} />
      <Route path="/moderation" element={<ModerationPage />} />
      <Route path="/scheduled" element={<ScheduledPage />} />
      <Route path="/giveaways" element={<GiveawaysPage />} />
      <Route path="/points" element={<PointsPage />} />
      <Route path="/audit" element={<AuditPage />} />
      <Route path="/operations" element={<OperationsPage />} />
      <Route path="/admin-accounts" element={<OwnerPage />} />
    </Route>
    <Route path="*" element={<Navigate to={hasToken() ? "/dashboard" : "/login"} replace />} />
  </Routes>;
}
