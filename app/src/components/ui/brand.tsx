// Loupe's logo: his face (the white body, the aperture eye, the red "recording" pupil) and the name.

export function LoupeMark({ className = "size-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className} aria-hidden>
      <circle cx="20" cy="20" r="18.5" fill="#FFFFFF" stroke="rgba(22,22,20,.2)" strokeWidth="1.2" />
      <circle cx="20" cy="20" r="11.5" fill="#161614" />
      <polygon points="25.4,20 22.7,24.68 17.3,24.68 14.6,20 17.3,15.32 22.7,15.32" fill="#FFF2EA" />
      <circle cx="20" cy="20" r="2.3" fill="#E2452B" />
    </svg>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-[-0.03em] ${className}`}>
      <LoupeMark className="size-[1.4em] drop-shadow-[0_1px_2px_rgba(20,20,18,0.12)]" />
      <span>Loupe</span>
    </span>
  );
}
