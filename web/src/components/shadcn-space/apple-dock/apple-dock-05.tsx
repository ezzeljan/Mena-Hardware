"use client";

import { useRef } from "react";
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type MotionValue,
} from "motion/react";
import type { LucideIcon } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";

const SIZE = 40;
const MAGNIFIED = 60;
const DISTANCE = 120;

// ---------------------------------------------------------------------------
// App navigation dock (used by the sidebar): icons magnify on hover, with real
// page links and the active item following the current page. Adapted from the
// shadcn-space apple-dock-05 demo (the demo itself was removed as unused).
// ---------------------------------------------------------------------------

export type DockNavItem = { label: string; icon: LucideIcon; to: string };

function isActivePath(pathname: string, to: string) {
  return pathname === to || pathname.startsWith(`${to}/`);
}

function SideDockLink({
  item,
  mouseY,
  active,
}: {
  item: DockNavItem;
  mouseY: MotionValue<number>;
  active: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  const distance = useTransform(mouseY, (value) => {
    const bounds = ref.current?.getBoundingClientRect() ?? { y: 0, height: 0 };
    return value - bounds.y - bounds.height / 2;
  });
  const target = useTransform(distance, [-DISTANCE, 0, DISTANCE], [SIZE, reduce ? SIZE : MAGNIFIED, SIZE]);
  const size = useSpring(target, { mass: 0.1, stiffness: 160, damping: 12 });

  return (
    <div className="group relative flex items-center">
      <motion.div ref={ref} style={{ width: size, height: size }}>
        <Link
          to={item.to}
          aria-label={item.label}
          aria-current={active ? "page" : undefined}
          className={cn(
            "flex h-full w-full items-center justify-center rounded-xl outline-none transition-colors focus-visible:ring-3 focus-visible:ring-neutral-950/40",
            active
              ? "bg-neutral-950 text-white"
              : "bg-neutral-200/70 text-neutral-600 hover:text-neutral-950",
          )}
        >
          <item.icon className="size-1/2" />
        </Link>
      </motion.div>
      <span className="pointer-events-none absolute left-full z-50 ml-3 rounded-md bg-neutral-950 px-2 py-1 text-xs font-medium whitespace-nowrap text-white opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        {item.label}
      </span>
    </div>
  );
}

/** Vertical navigation dock: icons magnify as the pointer moves along them. */
export function SideDock({ items, label = "Main navigation" }: { items: DockNavItem[]; label?: string }) {
  const mouseY = useMotionValue(Infinity);
  const { pathname } = useLocation();

  return (
    <nav
      aria-label={label}
      onMouseMove={(event) => mouseY.set(event.clientY)}
      onMouseLeave={() => mouseY.set(Infinity)}
      className="flex w-20 flex-col items-center gap-2 py-2.5"
    >
      {items.map((item) => (
        <SideDockLink
          key={item.to}
          item={item}
          mouseY={mouseY}
          active={isActivePath(pathname, item.to)}
        />
      ))}
    </nav>
  );
}
