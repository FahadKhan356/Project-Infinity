import { ImageResponse } from 'next/og';

// The app icon (brief §29, mobile application), drawn at build time: no
// image files to manage and no network. The mark keeps clear of the edges
// so it survives a maskable crop on Android.
export const size = { width: 512, height: 512 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <div style={{
        width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#1f5eff', color: 'white', fontSize: 300, fontWeight: 700,
      }}>
        A
      </div>
    ),
    { ...size },
  );
}
