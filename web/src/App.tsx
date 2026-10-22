import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { GameIcon, LockIcon, Mark, PlayerIcon, ReportIcon, WagerIcon } from "./components/Icons";
import { useSession } from "./lib/session";
import AboutPage from "./pages/AboutPage";
import AdminPage from "./pages/AdminPage";
import GamePage from "./pages/GamePage";
import PlayerPage from "./pages/PlayerPage";

const NAV = [
  { to: "/game", label: "Game", tip: "Game predictor", Icon: GameIcon },
  { to: "/player", label: "Player", tip: "Player projections", Icon: PlayerIcon },
  { to: "/about", label: "Report", tip: "Model report", Icon: ReportIcon },
];

export default function App() {
  const authed = useSession();
  // Until someone logs in, the page is only "Admin"; what it does stays out of the sidebar
  const admin = authed ? { label: "Wagers", tip: "Wagers", Icon: WagerIcon } : { label: "Admin", tip: "Admin", Icon: LockIcon };
  return (
    <div className="app">
      <nav className="rail" aria-label="Main">
        <NavLink to="/game" className="mark" aria-label="Hoops Predictor home"><Mark /></NavLink>
        {NAV.map(({ to, label, tip, Icon }) => (
          <NavLink key={to} to={to} className="rail-item" data-tip={tip} aria-label={tip}>
            <Icon /><span className="label">{label}</span>
          </NavLink>
        ))}
        <NavLink to="/admin" className="rail-item bottom" data-tip={admin.tip} aria-label={admin.tip}>
          <admin.Icon /><span className="label">{admin.label}</span>
        </NavLink>
      </nav>
      <main className="canvas">
        <Routes>
          <Route path="/" element={<Navigate to="/game" replace />} />
          <Route path="/game" element={<GamePage />} />
          <Route path="/player" element={<PlayerPage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="/admin" element={<AdminPage />} />
        </Routes>
      </main>
    </div>
  );
}
