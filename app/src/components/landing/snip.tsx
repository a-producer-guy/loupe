// Words cut in two, the way Loupe snips what it does away with: the top half tips one way, the bottom half the
// other. Used for the old numbers and times on the landing page, in place of crossing them out.

export function Snip({ cut, delay = 0, children }: { cut: boolean; delay?: number; children: string }) {
  const half = (top: boolean) => (
    <span
      aria-hidden="true"
      className={`absolute inset-0 whitespace-nowrap transition-transform duration-500 motion-reduce:transition-none ${top ? "[clip-path:inset(0_0_50%_0)]" : "[clip-path:inset(50%_0_0_0)]"}`}
      style={{ transform: cut ? (top ? "translate(-2px,-3px) rotate(-6deg)" : "translate(3px,3px) rotate(5deg)") : "none", transitionDelay: `${delay}ms` }}
    >
      {children}
    </span>
  );
  return (
    <span className="relative inline-block">
      <span className="invisible whitespace-nowrap" aria-hidden="true">
        {children}
      </span>
      {half(true)}
      {half(false)}
      <span className="sr-only">{children}</span>
    </span>
  );
}
