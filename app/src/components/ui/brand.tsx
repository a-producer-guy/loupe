// Reelarc's symbol (the R under an arc), drawn inline so the arc can glow pink.
export function ReelarcMark({ className = "size-7", arc = "var(--pink)" }: { className?: string; arc?: string }) {
  return (
    <svg viewBox="0 0 303 302" className={className} aria-hidden>
      <path
        fill="currentColor"
        d="M256.56 158.6C256.56 112.84 233.08 94.72 171.86 94.72H63.5996V301.04H107.37V224.11H162.88L215.57 301.04H263.48V293.64L205.95 218.52C231.24 214.34 256.56 204.35 256.56 158.6ZM213.56 159.41C213.56 181.12 203.63 190.55 173.47 190.55H107.37V131.14H172.69C203.66 131.14 213.59 137.71 213.59 159.41H213.56Z"
      />
      <path
        fill={arc}
        d="M302.42 49.38C258.532 17.2945 205.576 0.00109863 151.21 0.00109863C96.8443 0.00109863 43.8879 17.2945 0 49.38L27.76 77.18C64.0846 52.1495 107.161 38.7538 151.274 38.7699C195.387 38.786 238.454 52.213 274.76 77.27L302.42 49.38Z"
      />
    </svg>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-tight ${className}`}>
      <ReelarcMark className="size-[1.35em] text-text" />
      <span>
        Reelarc <span className="font-medium text-muted">Footage</span>
      </span>
    </span>
  );
}
