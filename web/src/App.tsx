import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { GameIcon, Mark, PlayerIcon, ReportIcon } from "./components/Icons";
import AboutPage from "./pages/AboutPage";
import GamePage from "./pages/GamePage";
import PlayerPage from "./pages/PlayerPage";

const NAV = [
  { to: "/game", label: "Game", tip: "Game predictor", Icon: GameIcon },
  { to: "/player", label: "Player", tip: "Player projections", Icon: PlayerIcon },
  { to: "/about", label: "Report", tip: "Model report", Icon: ReportIcon },
];

export default function App() {
  return (
    <div className="app">
      <nav className="rail" aria-label="Main">
        <NavLink to="/game" className="mark" aria-label="Hoops Predictor home"><Mark /></NavLink>
        {NAV.map(({ to, label, tip, Icon }) => (
          <NavLink key={to} to={to} className="rail-item" data-tip={tip} aria-label={tip}>
            <Icon /><span className="label">{label}</span>
          </NavLink>
        ))}
      </nav>
      <main className="canvas">
        <Routes>
          <Route path="/" element={<Navigate to="/game" replace />} />
          <Route path="/game" element={<GamePage />} />
          <Route path="/player" element={<PlayerPage />} />
          <Route path="/about" element={<AboutPage />} />
        </Routes>
      </main>
    </div>
  );
}
