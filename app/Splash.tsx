"use client";

import { useEffect, useState } from "react";

/** Écran d'intro : logo animé ~2,6 s, puis fondu vers l'application (chargée en dessous). */
const DURATION_MS = 2600;
const FADE_MS = 500;

export default function Splash() {
  const [phase, setPhase] = useState<"show" | "fade" | "done">("show");

  useEffect(() => {
    const t1 = setTimeout(() => setPhase("fade"), DURATION_MS);
    const t2 = setTimeout(() => setPhase("done"), DURATION_MS + FADE_MS);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  if (phase === "done") return null;

  return (
    <div className={`splash${phase === "fade" ? " splash-out" : ""}`} aria-hidden="true">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="splash-stage">
        <img className="splash-logo" src="/vigil-logo.png" alt="" />
        <div className="splash-shine" />
      </div>
      <div className="splash-bar"><span /></div>
    </div>
  );
}

const CSS = `
.splash{position:fixed;inset:0;z-index:99999;background:#fff;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:28px;transition:opacity ${FADE_MS}ms ease,visibility ${FADE_MS}ms;}
.splash-out{opacity:0;visibility:hidden;pointer-events:none}
.splash-stage{position:relative;width:min(560px,80vw);overflow:hidden}
.splash-logo{display:block;width:100%;height:auto;
  animation:splash-in 1.1s cubic-bezier(.2,.8,.2,1) both, splash-float 2.4s ease-in-out 1.1s infinite}
.splash-shine{position:absolute;inset:0;pointer-events:none;
  background:linear-gradient(105deg,transparent 35%,rgba(255,255,255,.85) 50%,transparent 65%);
  transform:translateX(-120%);animation:splash-shine 1s ease-in-out 1.2s both}
.splash-bar{width:min(220px,50vw);height:2px;background:#e5e7eb;border-radius:2px;overflow:hidden}
.splash-bar span{display:block;height:100%;background:#111;transform-origin:left;
  animation:splash-progress ${DURATION_MS}ms linear both}
@keyframes splash-in{
  0%{opacity:0;transform:scale(.92);clip-path:inset(0 100% 0 0);filter:blur(4px)}
  60%{opacity:1;filter:blur(0)}
  100%{opacity:1;transform:scale(1);clip-path:inset(0 0 0 0)}}
@keyframes splash-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
@keyframes splash-shine{to{transform:translateX(120%)}}
@keyframes splash-progress{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@media (prefers-reduced-motion:reduce){
  .splash-logo,.splash-shine,.splash-bar span{animation:none}
  .splash-shine{display:none}}
`;
