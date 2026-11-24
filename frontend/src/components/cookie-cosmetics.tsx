import { useId } from "react";

export function CookieCosmetics({ outfit }: { outfit: readonly string[] }) {
  const id = useId();
  const paint = (name: string) => `url(#${id}-${name})`;
  if (outfit.length === 0) return null;

  return (
    <svg aria-hidden="true" viewBox="0 0 40 40" className="absolute inset-0 h-full w-full overflow-visible" fill="none"
      strokeLinejoin="round" strokeLinecap="round">
      <defs>
        <linearGradient id={`${id}-silver`} x2="0" y2="1">
          <stop stopColor="#effcff" />
          <stop offset="1" stopColor="#558dce" stopOpacity=".85" />
        </linearGradient>
        <linearGradient id={`${id}-violet`} x2="0" y2="1">
          <stop stopColor="#bcb5ff" />
          <stop offset="1" stopColor="#382985" />
        </linearGradient>
        <linearGradient id={`${id}-gold`} x2="0" y2="1">
          <stop stopColor="#fff3b4" />
          <stop offset="1" stopColor="#df9632" />
        </linearGradient>
        <linearGradient id={`${id}-rose`} x2="0" y2="1">
          <stop stopColor="#ffcedf" />
          <stop offset="1" stopColor="#9a387a" />
        </linearGradient>
      </defs>
      {outfit.includes("headphones") && (
        <g data-cookie-cosmetic="headphones">
          <path d="M3.5 19a16.5 16.5 0 0 1 33 0" stroke="#243575" strokeWidth="3.5" />
          <path d="M3.5 19a16.5 16.5 0 0 1 33 0" stroke="#a6d7ff" strokeWidth="1.8" />
          <rect x=".1" y="16.7" width="6" height="10" rx="2.6" fill={paint("silver")} stroke="#304579" />
          <rect x="33.9" y="16.7" width="6" height="10" rx="2.6" fill={paint("silver")} stroke="#304579" />
          <path d="M2.4 19.5v4.3m35.2-4.3v4.3" stroke="#ecfaff" strokeWidth="1.1" />
        </g>
      )}
      {outfit.includes("glasses") && (
        <g data-cookie-cosmetic="glasses">
          <path d="m5.8 16.2 3.1 1.1m22.2 0 3.1-1.1M18.8 17.6q1.2-1 2.4 0" stroke="#daf8ff" strokeWidth="1.35" />
          <rect x="8.7" y="13.6" width="10" height="8.8" rx="3.3" fill="#a6eaff" fillOpacity=".1" stroke="#c9f1ff" strokeWidth="1.3" />
          <rect x="21.3" y="13.6" width="10" height="8.8" rx="3.3" fill="#a6eaff" fillOpacity=".1" stroke="#c9f1ff" strokeWidth="1.3" />
        </g>
      )}
      {outfit.includes("graduation-cap") && (
        <g data-cookie-cosmetic="graduation-cap">
          <path d="M12.5 1.8h15V7q-7.5 4-15 0Z" fill={paint("violet")} stroke="#d5c8ff" />
          <path d="m7.5 2 12.5-5.3L32.5 2 20 6.5Z" fill={paint("violet")} stroke="#e2d9ff" />
          <path d="m20 2 9.3 2.5v4.4m0 0-.6 2m.6-2 .75 2" stroke="#ffe693" strokeWidth="1.1" />
        </g>
      )}
      {outfit.includes("crown") && (
        <g data-cookie-cosmetic="crown">
          <path d="m10 .4 5.5 2.9L20-5l4.5 8.3L30 .4l-2.1 8Q20 10 12.1 8.4Z" fill={paint("gold")} stroke="#fff1be" />
          <path d="m20 2.5 1.6 2.2L20 7l-1.6-2.3Z" fill="#8a5bd7" stroke="#f9e3ff" strokeWidth=".55" />
        </g>
      )}
      {outfit.includes("scarf") && (
        <g data-cookie-cosmetic="scarf">
          <path d="m27 33 5-2 4 8.5-5.5 2Z" fill={paint("rose")} stroke="#ffdaeb" />
          <path d="M6 31.5q13.8 5 28 0l-.65 4.2Q20 42.6 7.1 35.8Z" fill={paint("rose")} stroke="#ffdaeb" />
          <path d="M10 34.3q8.3 3.4 17.5 1.25" stroke="#fff0f8" strokeWidth=".85" />
        </g>
      )}
    </svg>
  );
}
