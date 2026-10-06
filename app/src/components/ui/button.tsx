import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-colors select-none disabled:pointer-events-none disabled:opacity-50";
const sizes: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-9 px-3.5 text-[13.5px]",
  lg: "h-11 px-5 text-[15px]",
};
const variants: Record<ButtonVariant, string> = {
  primary:
    "bg-pink text-white hover:bg-pink-hover shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_8px_20px_-10px_rgba(255,61,138,0.7)]",
  secondary: "bg-surface-2 text-text border border-line-strong hover:bg-surface-3",
  ghost: "text-muted hover:text-text hover:bg-surface-2",
  danger: "text-bad hover:bg-bad-soft",
};

export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", extra = "") {
  return `${base} ${sizes[size]} ${variants[variant]} ${extra}`;
}

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} className={buttonClass(variant, size, className)} {...props} />;
}
