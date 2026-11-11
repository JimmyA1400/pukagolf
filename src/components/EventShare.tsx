"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

/**
 * An outing's link and QR code.
 *
 * Shown both when the outing is created and from inside it, because the person
 * who needs to pass the link on is usually not the person who made it — it is
 * whoever is standing on the first tee when a fourth turns up.
 *
 * Nothing is given away by showing it in the outing: the token in the address
 * bar IS the link, so anyone already looking at this page has it.
 */
export function EventShare({
  token,
  eventName,
  className = "",
}: {
  token: string;
  eventName: string;
  className?: string;
}) {
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Built from the live origin so the link matches whatever host is serving:
  // localhost in development, the real domain in production.
  const [url] = useState(() =>
    typeof window === "undefined"
      ? ""
      : `${window.location.origin}/event/${token}`,
  );

  useEffect(() => {
    if (!url) return;

    void QRCode.toDataURL(url, { margin: 1, width: 512 }).then(setQr);
  }, [url]);

  return (
    <div className={`text-center ${className}`}>
      {qr && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={qr}
          alt={`QR code linking to ${eventName}`}
          className="mx-auto w-full max-w-[240px] border border-hairline bg-card p-3"
        />
      )}

      <p className="mt-3 break-all border border-hairline bg-card px-4 py-3 font-mono text-xs">
        {url}
      </p>

      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
          } catch {
            // Clipboard access is refused on an insecure origin and in some
            // in-app browsers. The link is on screen either way.
            setCopied(false);
          }
        }}
        className="mt-3 min-h-12 w-full bg-forest-deep px-4 font-mono text-xs tracking-wider text-cream uppercase"
      >
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}
