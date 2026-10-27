import { useState } from 'react';
import { Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import { Loading } from './ui.jsx';
import { Login, Register, Forgot, ResetPassword, AcceptInvite, MfaSetup } from './pages/Auth.jsx';
import { StudentDashboard, StudentCourses, StudentAssessments, AssessmentIntro, History, Announcements, ReportIssue } from './pages/Student.jsx';
import ExamRunner from './pages/ExamRunner.jsx';
import ResultView from './pages/ResultView.jsx';
import { StaffDashboard, CourseList, CourseWorkspace } from './pages/Staff.jsx';
import QuestionEditor from './pages/QuestionEditor.jsx';
import AssessmentWizard from './pages/AssessmentWizard.jsx';
import AssessmentDetail from './pages/AssessmentDetail.jsx';
import { GradingQueue, Grader } from './pages/Grading.jsx';
import { AdminDashboard, AdminCourses, AdminUsers, AdminOrg, AdminIncidents, AdminAudit, AdminConfig, AdminHealth, AdminAccommodations } from './pages/Admin.jsx';

const NAV = {
  student: [['/', 'Dashboard'], ['/courses', 'My courses'], ['/assessments', 'Assessments'], ['/history', 'History'], ['/announcements', 'Announcements'], ['/issues', 'Report an issue']],
  staff: [['/', 'Dashboard'], ['/courses', 'Courses'], ['/grading', 'Grading queue']],
  admin: [['/', 'Dashboard'], ['/courses', 'Courses'], ['/grading', 'Grading queue'], ['/admin/courses', 'Catalogue & courses'], ['/admin/users', 'Users & roles'], ['/admin/org', 'Terms, offerings, enrolments'], ['/admin/accommodations', 'Accommodations'], ['/admin/incidents', 'Incidents'], ['/admin/audit', 'Audit log'], ['/admin/config', 'Configuration'], ['/admin/health', 'System health']]
};

function Shell() {
  const { user, logout, can, isStudent } = useAuth(); const [open, setOpen] = useState(false);
  const items = isStudent ? NAV.student : can('course.read_all') ? NAV.admin.filter(([p]) => !p.startsWith('/admin/config') || can('config.manage')) : NAV.staff;
  return <div className="shell">
    <a className="skip" href="#main">Skip to content</a>
    <aside className={`side ${open ? 'open' : ''}`}>
      <div className="brand"><img src="/logo.png" alt="" /><span>KellasTech<br /><small>Examination Portal</small></span><button className="btn small ghost menu-btn" style={{ color: '#fff', borderColor: '#fff' }} onClick={() => setOpen(!open)} aria-expanded={open}>Menu</button></div>
      <nav aria-label="Main">{items.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'} onClick={() => setOpen(false)}>{label}</NavLink>)}</nav>
      <div className="who">{user.full_name}<br />{user.role_key.replace('_', ' ')}<br /><button className="btn small ghost" style={{ color: '#fff', borderColor: '#fff', marginTop: 8 }} onClick={logout}>Sign out</button></div>
    </aside>
    <main id="main" className="main"><Outlet /><div className="site-footer">© {new Date().getFullYear()} KellasTech · times shown in Africa/Accra · <a href="https://kellastech.vercel.app/">kellastech.vercel.app</a></div></main>
  </div>;
}

function Guard() {
  const { loading, user, mfaSetup } = useAuth(); const loc = useLocation();
  if (loading) return <Loading text="Starting…" />;
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (mfaSetup && loc.pathname !== '/mfa') return <Navigate to="/mfa" replace />;
  return <Shell />;
}
const Home = () => { const { isStudent, can } = useAuth(); return isStudent ? <StudentDashboard /> : can('course.read_all') ? <AdminDashboard /> : <StaffDashboard />; };
const Courses = () => { const { isStudent } = useAuth(); return isStudent ? <StudentCourses /> : <CourseList />; };
const StaffOnly = ({ children }) => { const { isStaff } = useAuth(); return isStaff ? children : <Navigate to="/" replace />; };

export default function App() {
  return <Routes>
    <Route path="/login" element={<Login />} /><Route path="/register" element={<Register />} /><Route path="/forgot" element={<Forgot />} />
    <Route path="/reset" element={<ResetPassword />} /><Route path="/accept-invite" element={<AcceptInvite />} />
    <Route element={<Guard />}>
      <Route path="/" element={<Home />} /><Route path="/mfa" element={<MfaSetup />} /><Route path="/courses" element={<Courses />} />
      <Route path="/assessments" element={<StudentAssessments />} /><Route path="/assessments/:id" element={<AssessmentIntro />} />
      <Route path="/exam/:attemptId" element={<ExamRunner />} /><Route path="/results/:attemptId" element={<ResultView />} />
      <Route path="/history" element={<History />} /><Route path="/announcements" element={<Announcements />} /><Route path="/issues" element={<ReportIssue />} />
      <Route path="/courses/:id" element={<StaffOnly><CourseWorkspace /></StaffOnly>} />
      <Route path="/questions/:id" element={<StaffOnly><QuestionEditor /></StaffOnly>} />
      <Route path="/assessments/:id/edit" element={<StaffOnly><AssessmentWizard /></StaffOnly>} />
      <Route path="/manage/assessments/:id" element={<StaffOnly><AssessmentDetail /></StaffOnly>} />
      <Route path="/grading" element={<StaffOnly><GradingQueue /></StaffOnly>} /><Route path="/grading/:attemptId" element={<StaffOnly><Grader /></StaffOnly>} />
      <Route path="/admin/courses" element={<StaffOnly><AdminCourses /></StaffOnly>} /><Route path="/admin/users" element={<StaffOnly><AdminUsers /></StaffOnly>} />
      <Route path="/admin/org" element={<StaffOnly><AdminOrg /></StaffOnly>} /><Route path="/admin/accommodations" element={<StaffOnly><AdminAccommodations /></StaffOnly>} />
      <Route path="/admin/incidents" element={<StaffOnly><AdminIncidents /></StaffOnly>} /><Route path="/admin/audit" element={<StaffOnly><AdminAudit /></StaffOnly>} />
      <Route path="/admin/config" element={<StaffOnly><AdminConfig /></StaffOnly>} /><Route path="/admin/health" element={<StaffOnly><AdminHealth /></StaffOnly>} />
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>;
}
