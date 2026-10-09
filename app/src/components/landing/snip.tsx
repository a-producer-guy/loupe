// Words cut in two, the way Loupe snips what it does away with. Every cut is its own: across or down, straight or
// on a slant, at a different height, the two pieces flung apart by different amounts. The cut is worked out from the
// words and a seed, so the server and the browser draw the same one; a new seed makes a new cut.

/** A number from 0 to 1, the same every time for the same text and seed. */
function rand(text: string, seed: number, k: number) {
  let h = 2166136261 ^ (seed * 374761393 + k * 668265263);
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

type Piece = { clip: string; moved: string };

function cutOf(text: string, seed: number): [Piece, Piece] {
  const r = (k: number, lo: number, hi: number) => lo + rand(text, seed, k) * (hi - lo);
  const sign = rand(text, seed, 9) < 0.5 ? -1 : 1;
  const turn = r(5, 3, 11);
  const push = r(6, 1.5, 4.5);
  // Mostly across the words (they're short and wide); now and then down through them.
  if (rand(text, seed, 0) < 0.72) {
    const a = r(1, 18, 82);
    const b = Math.min(88, Math.max(12, a + r(2, -45, 45)));
    return [
      { clip: `polygon(0 0, 100% 0, 100% ${b}%, 0 ${a}%)`, moved: `translate(${-sign * push * 0.6}px, ${-push}px) rotate(${-sign * turn}deg)` },
      { clip: `polygon(0 ${a}%, 100% ${b}%, 100% 100%, 0 100%)`, moved: `translate(${sign * push * 0.8}px, ${push}px) rotate(${sign * turn * r(7, 0.6, 1.1)}deg)` },
    ];
  }
  const a = r(1, 30, 70);
  const b = Math.min(85, Math.max(15, a + r(2, -30, 30)));
  return [
    { clip: `polygon(0 0, ${a}% 0, ${b}% 100%, 0 100%)`, moved: `translate(${-push * 1.2}px, ${sign * push * 0.5}px) rotate(${-turn}deg)` },
    { clip: `polygon(${a}% 0, 100% 0, 100% 100%, ${b}% 100%)`, moved: `translate(${push * 1.2}px, ${-sign * push * 0.5}px) rotate(${turn * r(7, 0.6, 1.1)}deg)` },
  ];
}

export function Snip({ cut, delay = 0, seed = 0, children }: { cut: boolean; delay?: number; seed?: number; children: string }) {
  const pieces = cutOf(children, seed);
  return (
    <span className="relative inline-block">
      <span className="invisible whitespace-nowrap" aria-hidden="true">
        {children}
      </span>
      {pieces.map((p, i) => (
        <span
          key={i}
          aria-hidden="true"
          className="absolute inset-0 whitespace-nowrap transition-transform duration-500 motion-reduce:transition-none"
          style={{ clipPath: p.clip, transform: cut ? p.moved : "none", transitionDelay: `${delay}ms` }}
        >
          {children}
        </span>
      ))}
      <span className="sr-only">{children}</span>
    </span>
  );
}
