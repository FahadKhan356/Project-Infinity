import type { MetadataRoute } from 'next';

/**
 * Makes the portal installable on a phone or desktop (brief §29, mobile
 * application): "Add to Home Screen" gives it its own icon and a full-screen
 * window, still served from the office server with nothing to download from
 * an app store and nothing that works outside the network.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Aktivacity Portal',
    short_name: 'Aktivacity',
    description: 'Projects, work, QA and delivery at Aktivacity.',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    background_color: '#f5f6f8',
    theme_color: '#1f5eff',
    icons: [
      { src: '/icon', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/apple-icon', sizes: '180x180', type: 'image/png' },
    ],
  };
}
