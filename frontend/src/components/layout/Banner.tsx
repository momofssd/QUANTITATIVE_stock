/** Page-level error / warning message. */
import type { BannerState } from "../../hooks/useBanner";

export function Banner({ banner }: { banner: BannerState | null }) {
  if (!banner) return null;
  return (
    <div className={`banner${banner.kind === "warn" ? " warn" : ""}`} role="alert">
      {banner.title && <b>{banner.title} </b>}
      {banner.envHint ? (
        <>
          Add <code>ALPACA_API_KEY</code> and <code>ALPACA_SECRET_KEY</code> (and optionally <code>ALPACA_ENDPOINT</code>)
          to the <code>.env</code> file in the project root and save it. The page connects automatically.
        </>
      ) : (
        banner.message
      )}
    </div>
  );
}
