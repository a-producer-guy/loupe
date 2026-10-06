import { Check } from "lucide-react";
import Link from "next/link";
import { HeroLoupe } from "@/components/landing/hero-loupe";
import { Savings } from "@/components/landing/savings";
import { Loupe, type LoupeDept } from "@/components/loupe/loupe";
import { Wordmark } from "@/components/ui/brand";
import { PLANS } from "@/lib/footage/account-view";

// Loupe's public landing page. Everything else needs signing in; this page doesn't (see proxy.ts).

const cta = "inline-flex h-11 items-center justify-center rounded-xl bg-text px-5 text-[14.5px] font-medium text-white shadow-lift-sm transition hover:shadow-lift";
const ctaSoft = "inline-flex h-11 items-center justify-center rounded-xl bg-surface px-5 text-[14.5px] font-medium text-text ring-1 ring-line-strong transition hover:shadow-lift-sm";
const h2 = "text-[clamp(32px,4.2vw,52px)] font-semibold leading-none tracking-[-0.045em] text-balance";
const lede = "mt-3.5 max-w-[56ch] text-[17px] text-muted";

const MODES: { dept: LoupeDept; name: string; key: string; does: string; say: string }[] = [
  { dept: "edit", name: "Edit", key: "⌥1", does: "Takes, timing, reactions.", say: "“different take”" },
  { dept: "sound", name: "Sound", key: "⌥2", does: "Dialogue, room tone, atmosphere.", say: "“rain outside”" },
  { dept: "color", name: "Color", key: "⌥3", does: "Warmth, contrast, matching shots.", say: "“warmer”" },
  { dept: "preview", name: "Preview", key: "⌥4", does: "Watch and ask. Nothing changes.", say: "“why this take?”" },
];

const FAQ: { q: string; a: React.ReactNode }[] = [
  {
    q: "Does Loupe replace my editor?",
    a: "No. Loupe builds the first assembly: picks the best takes, lines them up with the script, adds reactions and clean dialogue. Many scenes are ready to share from there; for the rest, your editor starts from a solid cut instead of a pile of clips.",
  },
  {
    q: "What can Loupe edit?",
    a: (
      <>
        <p>Loupe builds the first assembly of scripted scenes: many takes, shot as coverage, cut to a script.</p>
        <List title="Works today" items={["Short films, one scene at a time", "Scenes for feature films and TV pilots", "Web series and sketch", "Actors’ demo reel scenes", "Film school exercises", "Scripted commercials and branded films with dialogue", "Self-tapes with several takes (Loupe picks and trims the best one)"]} />
        <List title="Coming later" items={["Shoots with two or more cameras rolling at once", "Scenes without dialogue: action, montage, music videos", "Documentary and interviews, cut from a transcript instead of a script", "Whole films in one go, not scene by scene", "Export for DaVinci Resolve, Final Cut and Avid"]} />
        <List title="Not what Loupe is for" items={["Turning long videos into short social clips", "Podcasts, vlogs, livestreams and webinars", "Weddings and live events"]} />
      </>
    ),
  },
  {
    q: "How is Loupe different from Opus Clip and other clipping tools?",
    a: (
      <>
        <p>
          Clipping tools cut down: they take a finished long video and pull out short clips for social media. Loupe builds up: it takes raw camera
          footage and a script and assembles the scene, the way an assistant editor does before there’s a film.
        </p>
        <div className="my-4 overflow-x-auto">
          <table className="w-full text-[14px]">
            <thead>
              <tr className="text-left text-[13px]">
                <th className="pb-2 pr-3" />
                <th className="pb-2 pr-3 font-semibold">Clipping tools</th>
                <th className="pb-2 font-semibold">Loupe</th>
              </tr>
            </thead>
            <tbody className="text-muted">
              {[
                ["You give it", "One finished video", "Every take from the shoot, the sound and the script"],
                ["It decides", "Which moments might go viral", "The best take for every line, reactions, J and L cuts, no jump cuts"],
                ["You get", "Vertical clips with captions, ready to post", "A Premiere timeline with alternates, reasons and proxies, ready to edit"],
                ["Made for", "Creators and marketers", "Filmmakers, editors and production companies"],
              ].map(([k, a, b]) => (
                <tr key={k} className="border-t border-line align-top">
                  <td className="w-[22%] py-2 pr-3 text-faint">{k}</td>
                  <td className="py-2 pr-3">{a}</td>
                  <td className="py-2">{b}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>Use a clipping tool for your podcast. Use Loupe for your film.</p>
      </>
    ),
  },
  { q: "What do I need to give it?", a: "The folder from the shoot (camera cards and sound) and the script as a Final Draft, Fountain or PDF file. Single-camera dialogue scenes work best today." },
  { q: "How long does it take?", a: "Uploading depends on your internet. Once the footage is in, the cut is usually ready in minutes." },
  { q: "Does it work with Premiere?", a: "Yes. Export gives you a Premiere timeline with every alternate take stacked above each shot, a marker saying why each take was picked, and proxies attached so it plays smoothly." },
  { q: "Is my footage private?", a: "Your footage is yours. It’s stored privately and used only to cut your scenes." },
  {
    q: "How long do you keep my footage?",
    a: "Your original camera files are kept free for 30 days after export on Indie, 60 on Pro and 90 on Studio. We email you 7 days and 3 days before they’re deleted, with a download link. Cuts, timelines and proxies are kept for good. To keep originals longer, switch on Keep footage for $20 per TB a month.",
  },
  {
    q: "Can I wipe my cards after uploading?",
    a: "Every file is checked after upload, but keep your own copy until you’ve exported. If you want Loupe to be your backup, switch on Keep footage and we’ll hold the originals for as long as you pay for it.",
  },
  { q: "Why pay at export?", a: "Because you should see Loupe cut your own footage before you pay anything. Uploading, watching the cut and directing it are free for your first scene." },
];

function List({ title, items }: { title: string; items: string[] }) {
  return (
    <>
      <h4 className="mb-1.5 mt-4 text-[13.5px] font-semibold text-text">{title}</h4>
      <ul className="grid list-disc gap-1 pl-5">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </>
  );
}

export default function Landing() {
  return (
    <div className="bg-bg text-[15px] leading-[1.55]">
      <header className="mx-auto flex max-w-[1160px] items-center gap-6 px-6 py-[18px]">
        <Link href="/" aria-label="Loupe home">
          <Wordmark className="text-[18px]" />
        </Link>
        <nav className="hidden gap-[22px] text-[14px] text-muted md:flex" aria-label="Sections">
          <a href="#how" className="hover:text-text">How it works</a>
          <a href="#savings" className="hover:text-text">Savings</a>
          <a href="#pricing" className="hover:text-text">Pricing</a>
          <a href="#studios" className="hover:text-text">For studios</a>
        </nav>
        <div className="ml-auto flex items-center gap-4">
          <Link href="/login" className="hidden text-[14px] text-muted underline decoration-faint underline-offset-4 hover:text-text sm:inline">Sign in</Link>
          <Link href="/login" className="inline-flex h-9 items-center rounded-[10px] bg-text px-3.5 text-[13.5px] font-medium text-white">Cut your first scene free</Link>
        </div>
      </header>

      <main>
        <section className="mx-auto grid max-w-[1160px] items-center gap-6 px-6 pb-16 pt-[5vh] md:grid-cols-[1.15fr_0.85fr]" aria-label="Loupe">
          <div>
            <p className="mb-3.5 text-[13px] text-faint">An assistant editor for scripted scenes</p>
            <h1 className="mb-5 text-[clamp(52px,8.4vw,116px)] font-semibold leading-[0.9] tracking-[-0.06em] text-balance">
              Direct your edit<span className="text-faint">.</span>
            </h1>
            <p className="mb-7 max-w-[40ch] text-[clamp(17px,1.6vw,20px)] text-muted">
              Drop your scene. Loupe watches every take, lines it up with your script and hands you a first cut, with a reason for every shot. Then you give
              notes, like you would to an editor.
            </p>
            <div className="flex flex-wrap items-center gap-x-[18px] gap-y-3">
              <Link href="/login" className={cta}>Cut your first scene free</Link>
              <a href="#how" className="text-muted underline decoration-faint underline-offset-4 hover:text-text">See how it works</a>
            </div>
            <div className="mt-[18px] flex flex-wrap gap-x-[18px] gap-y-1 text-[13px] text-faint">
              {["First scene free", "No card to start", "Opens in Premiere"].map((t) => (
                <span key={t}>
                  <span className="text-good">✓</span> {t}
                </span>
              ))}
            </div>
          </div>
          <HeroLoupe />
        </section>

        <section className="mx-auto grid max-w-[1160px] gap-[18px] px-6 pb-[76px] md:grid-cols-3" aria-label="What you get">
          {[
            { big: "Minutes", h: "Not hours", p: "A first assembly takes an editor 2–4 hours. Loupe has yours ready while you get a coffee." },
            { big: <><s className="mr-1 text-[0.6em] text-faint decoration-2">$60</s>$25</>, h: "Per scene, for studios", p: "An editor’s assembly costs $60–250 a scene. Studios cut theirs with Loupe for about $25, so the editor spends their time on the craft." },
            { big: "Every take", h: "One click away", p: "Click any line and hear it in every take, back to back. Pick the one you want. No scrubbing through clips." },
          ].map((b) => (
            <div key={b.h} className="rounded-[20px] bg-surface p-[26px] shadow-lift">
              <div className="mb-3 text-[clamp(38px,4.4vw,56px)] font-light leading-none tracking-[-0.05em] tabular-nums">{b.big}</div>
              <h3 className="mb-1.5 text-[17px] font-semibold tracking-[-0.01em]">{b.h}</h3>
              <p className="text-[14.5px] text-muted">{b.p}</p>
            </div>
          ))}
        </section>

        <section id="savings" className="mx-auto max-w-[1160px] scroll-mt-5 px-6 pb-[88px]">
          <h2 className={h2}>See what you’d save</h2>
          <p className={`${lede} mb-8`}>Move the sliders to match how you work. It picks the cheapest plan for you.</p>
          <Savings />
        </section>

        <section id="how" className="mx-auto max-w-[1160px] scroll-mt-5 px-6 pb-[88px]">
          <h2 className={h2}>Three steps. You only direct.</h2>
          <p className={`${lede} mb-8`}>No timeline to wrestle and no settings to learn. The editing labor happens in the background.</p>
          <div className="grid gap-[18px] md:grid-cols-3">
            {[
              { n: 1, h: "Drop the folder", p: "It uploads, keeps your folders as shot and makes Premiere proxies, and checks every file arrived in full." },
              { n: 2, h: "Watch it cut", p: "Loupe hears every take, matches each one to your script and builds the scene: best reads, reactions, J and L cuts, clean dialogue." },
              { n: 3, h: "Direct, then export", p: "Click a line to hear it in every take, or just say “tighter” or “warmer”. Export a Premiere timeline with every alternate stacked and every reason marked." },
            ].map((s) => (
              <div key={s.n} className="grid content-start gap-3.5">
                <div className="grid aspect-[4/3] place-items-center rounded-[20px] bg-surface shadow-lift">
                  <Loupe size={92} mood={s.n === 2 ? "think" : s.n === 3 ? "happy" : "listen"} dept="edit" />
                </div>
                <span className="text-[12.5px] text-faint">{s.n}</span>
                <h3 className="text-[18px] font-semibold tracking-[-0.02em]">{s.h}</h3>
                <p className="text-[14.5px] text-muted">{s.p}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-[1160px] px-6 pb-[88px]" aria-labelledby="modes">
          <h2 id="modes" className={h2}>One editor, four hats</h2>
          <p className={`${lede} mb-8`}>Switch what Loupe works on with ⌥1–4 or a slash command. Your next note only changes that.</p>
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
            {MODES.map((m) => (
              <div key={m.dept} className="grid justify-items-start gap-2 rounded-[14px] bg-surface p-5 shadow-lift-sm ring-1 ring-line">
                <Loupe size={46} dept={m.dept} />
                <h3 className="mt-1.5 flex items-center gap-2 text-[16px] font-semibold">
                  {m.name}
                  <kbd className="rounded-[5px] bg-bg px-1.5 font-mono text-[11px] font-normal text-faint ring-1 ring-line">{m.key}</kbd>
                </h3>
                <p className="text-[13.5px] text-muted">{m.does}</p>
                <span className="font-mono text-[12px] text-faint">{m.say}</span>
              </div>
            ))}
          </div>
        </section>

        <section id="studios" className="mx-auto grid max-w-[1160px] scroll-mt-5 items-center gap-10 px-6 pb-24 md:grid-cols-2" aria-label="Loupe and editors">
          <blockquote>
            <p className="text-[clamp(22px,2.4vw,30px)] font-medium leading-tight tracking-[-0.025em] text-balance">
              “I’m not here to take an editor’s job. I do the sorting; editors make it sing.”
            </p>
            <footer className="mt-4 flex items-center gap-2.5 text-[14px] text-faint">
              <Loupe size={30} mood="happy" /> Loupe
            </footer>
          </blockquote>
          <div className="grid gap-3.5">
            {[
              ["Filmmakers without an editor", "Loupe is your assistant editor. You direct; it cuts."],
              ["Editors", "Skip the assembly. Spend your hours, and your invoice, on the craft."],
              ["Reel companies and studios", "Built inside Reelarc, which cuts 50+ scenes a month. Studio plans cut editing costs per scene by more than half."],
            ].map(([b, s]) => (
              <div key={b} className="rounded-[14px] bg-surface px-[18px] py-4 ring-1 ring-line">
                <b className="mb-0.5 block font-semibold">{b}</b>
                <span className="text-[14px] text-muted">{s}</span>
              </div>
            ))}
          </div>
        </section>

        <section id="pricing" className="mx-auto max-w-[1160px] scroll-mt-5 px-6 pb-[88px]">
          <h2 className={h2}>Pay when you export</h2>
          <p className={`${lede} mb-8`}>Upload, watch your first cut and direct it for free. You only pay to take the timeline into Premiere.</p>
          <div className="mb-[18px] grid items-start gap-[18px] md:grid-cols-3">
            {PLANS.map((plan) => (
              <div key={plan.id} className={`grid gap-4 rounded-[20px] bg-surface p-[26px] ${plan.id === "pro" ? "shadow-lift ring-2 ring-text" : "shadow-lift-sm ring-1 ring-line"}`}>
                {plan.id === "pro" && <span className="justify-self-start rounded-full bg-text px-2.5 py-0.5 text-[11.5px] font-medium text-white">For editors</span>}
                <div>
                  <h3 className="text-[18px] font-semibold">{plan.name}</h3>
                  <p className="text-[13.5px] text-faint">{plan.for}</p>
                </div>
                <p className="text-[46px] font-light leading-none tracking-[-0.05em] tabular-nums">
                  {plan.price}
                  <span className="ml-1 text-[14px] font-normal tracking-normal text-faint">{plan.per}</span>
                </p>
                <ul className="grid gap-2 text-[14px] text-muted">
                  {[...plan.points, plan.keeps].map((p) => (
                    <li key={p} className="flex gap-1.5">
                      <Check className="mt-0.5 size-4 shrink-0 text-good" /> {p}
                    </li>
                  ))}
                </ul>
                <Link href="/login" className={plan.id === "pro" ? cta : ctaSoft}>
                  {plan.id === "indie" ? "Cut your first scene free" : plan.id === "pro" ? "Start Pro" : "Talk to us"}
                </Link>
              </div>
            ))}
          </div>
          <div className="mb-3.5 flex flex-wrap items-center gap-x-6 gap-y-2.5 rounded-[14px] bg-surface px-5 py-4 ring-1 ring-line">
            <div>
              <b className="block font-semibold">Keep footage longer</b>
              <span className="text-[14px] text-muted">$20 per TB a month, for any scene you choose. Cuts, timelines and proxies are always kept, free.</span>
            </div>
            <span className="ml-auto text-[13px] text-faint">About $2 a month for a typical 100 GB scene</span>
          </div>
          <p className="text-[14px] text-muted">Prices in US dollars, plus any sales tax. Cancel any time.</p>
        </section>

        <section className="mx-auto max-w-[1160px] px-6 pb-24" aria-labelledby="faq">
          <h2 id="faq" className={h2}>Questions</h2>
          <div className="mt-7 grid max-w-[820px] gap-2.5">
            {FAQ.map(({ q, a }) => (
              <details key={q} className="group rounded-[14px] bg-surface px-5 ring-1 ring-line">
                <summary className="flex cursor-pointer list-none justify-between gap-4 py-[17px] font-medium after:text-[20px] after:font-light after:leading-none after:text-faint after:content-['+'] group-open:after:content-['–']">
                  {q}
                </summary>
                <div className="mb-[18px] max-w-[66ch] text-[14.5px] text-muted [&_p+p]:mt-3">{typeof a === "string" ? <p>{a}</p> : a}</div>
              </details>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-[1160px] px-6 pb-14" aria-label="Get started">
          <div className="grid items-center gap-[30px] rounded-[28px] bg-surface p-7 shadow-lift sm:p-11 md:grid-cols-[auto_1fr_auto]">
            <Loupe size={86} dept="edit" />
            <div>
              <h2 className="mb-1.5 text-[clamp(28px,3.4vw,42px)] font-semibold leading-none tracking-[-0.045em]">Drop your first scene.</h2>
              <p className="text-muted">It’s free. Loupe will be waiting.</p>
            </div>
            <Link href="/login" className={cta}>Cut your first scene free</Link>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex max-w-[1160px] flex-wrap items-center gap-x-7 gap-y-3.5 border-t border-line px-6 pb-10 pt-[26px] text-[13px] text-faint">
        <Wordmark className="text-[15px] text-text" />
        <span>© 2026 Loupe · Made by Reelarc</span>
        <nav className="flex gap-5 sm:ml-auto" aria-label="Footer">
          <a href="#pricing" className="hover:text-text">Pricing</a>
          <a href="#faq" className="hover:text-text">Questions</a>
          <Link href="/login" className="hover:text-text">Sign in</Link>
        </nav>
      </footer>
    </div>
  );
}
